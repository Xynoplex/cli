package provenance

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

const gatewayImage = "ghcr.io/xynolog/xynolog-gateway:latest"

// xynolog: a release of Xynolog's, by workflow.
func xynolog(workflow string) Release {
	return Release{Repository: "xynolog/images", Workflow: workflow}
}

// released: the gateway as a services release publishes it, with build
// provenance of its digest signed for that workflow at a release tag.
func released(t *testing.T) *authority {
	t.Helper()
	a := newAuthority(t)
	a.attest(t, servicesRelease, buildProvenance, a.digestOf)
	return a
}

// A release's attestation, held to what it does not say.
func TestAReleaseIsRefusedForWhatItIsNot(t *testing.T) {
	release := signerOf(xynolog("publish-service-images.yml"))
	for _, c := range []struct {
		name       string
		otherImage bool
		signer     signer
	}{
		{"another workflow's release", false, signerOf(xynolog("publish-browser.yml"))},
		{"another repository's release", false, signerOf(Release{Repository: "someone/xynolog", Workflow: "publish-service-images.yml"})},
		{"another image's digest", true, release},
		{"another issuer", false, signer{issuer: "https://accounts.google.com", identity: release.identity, what: "Google's"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := released(t)
			if c.otherImage {
				a.digestOf = "sha256:" + strings.Repeat("0", 64)
			}
			if digest, err := verifyWith(a, gatewayImage, c.signer); err == nil {
				t.Fatalf("verified %s", digest)
			} else if !strings.Contains(err.Error(), gatewayImage) {
				t.Errorf("the refusal does not name the image: %v", err)
			}
		})
	}
}

// Every Verifier the interface keeps in view refuses an image no release
// built; the Refuser refuses a release's too.
func TestNoVerifierAcceptsWhatNoReleaseBuilt(t *testing.T) {
	for name, v := range map[string]Verifier{"sigstore": sigstoreVerifier{released(t)}, "refuser": Refuser{}} {
		if digest, err := v.Verify(gatewayImage, xynolog("publish-browser.yml")); err == nil {
			t.Errorf("%s verified the services' image as the Browser's release: %s", name, digest)
		}
	}
	if _, err := (Refuser{}).Verify(gatewayImage, xynolog("publish-service-images.yml")); !errors.Is(err, ErrUnverifiable) {
		t.Errorf("the Refuser said %v of a release's image, want ErrUnverifiable", err)
	}
}

// authority: an attestation made and checked by Sigstore's test authority,
// for what no real attestation of ours says — a build from a branch, from a
// fork, a predicate that is not provenance.
type authority struct {
	ca       *ca.VirtualSigstore
	digestOf string
	entities []verify.SignedEntity
}

func newAuthority(t *testing.T) *authority {
	t.Helper()
	vs, err := ca.NewVirtualSigstore()
	if err != nil {
		t.Fatal(err)
	}
	return &authority{ca: vs, digestOf: "sha256:" + strings.Repeat("ab", 32)}
}

func (a *authority) attest(t *testing.T, identity, predicate, subject string) {
	t.Helper()
	statement, err := json.Marshal(map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []map[string]any{{"name": gatewayImage, "digest": map[string]string{"sha256": strings.TrimPrefix(subject, "sha256:")}}},
		"predicateType": predicate,
		"predicate":     map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	entity, err := a.ca.Attest(identity, githubActions, statement)
	if err != nil {
		t.Fatal(err)
	}
	a.entities = append(a.entities, entity)
}

func (a *authority) digest(string) (string, error) { return a.digestOf, nil }
func (a *authority) attestations(string, string) ([]verify.SignedEntity, error) {
	return a.entities, nil
}
func (a *authority) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	return a.ca, []verify.VerifierOption{verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1)}, nil
}

const (
	servicesWorkflow = "https://github.com/xynolog/images/.github/workflows/publish-service-images.yml"
	servicesRelease  = servicesWorkflow + "@refs/tags/v0.7.0"
)

func TestAReleaseIsSignedAtAReleaseTag(t *testing.T) {
	for _, c := range []struct {
		name, identity string
		accepted       bool
	}{
		{"at a release tag", servicesRelease, true},
		{"from main", servicesWorkflow + "@refs/heads/main", false},
		{"from a branch named like a tag", servicesWorkflow + "@refs/heads/refs/tags/v0.7.0", false},
		{"at a tag that is not a release", servicesWorkflow + "@refs/tags/nightly", false},
		{"from a fork", "https://github.com/someone/xynolog/.github/workflows/publish-service-images.yml@refs/tags/v0.7.0", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			a := newAuthority(t)
			a.attest(t, c.identity, buildProvenance, a.digestOf)
			digest, err := sigstoreVerifier{a}.Verify(gatewayImage, xynolog("publish-service-images.yml"))
			if c.accepted && (err != nil || digest != a.digestOf) {
				t.Fatalf("refused: %v", err)
			}
			if !c.accepted && err == nil {
				t.Fatalf("an image signed by %s was verified", c.identity)
			}
		})
	}
}

func TestOnlyBuildProvenanceOfTheDigestVerifies(t *testing.T) {
	release := servicesRelease
	check := func(a *authority) error {
		_, err := sigstoreVerifier{a}.Verify(gatewayImage, xynolog("publish-service-images.yml"))
		return err
	}
	t.Run("a bill of materials is not provenance", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digestOf)
		if err := check(a); err == nil || !strings.Contains(err.Error(), "not build provenance") {
			t.Fatalf("want a refusal naming the predicate, got %v", err)
		}
	})
	t.Run("provenance of another digest", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, buildProvenance, "sha256:"+strings.Repeat("cd", 32))
		if err := check(a); err == nil {
			t.Fatal("provenance of another image verified this one")
		}
	})
	t.Run("one good attestation among others", func(t *testing.T) {
		a := newAuthority(t)
		a.attest(t, release, "https://spdx.dev/Document/v2.3", a.digestOf)
		a.attest(t, release, buildProvenance, a.digestOf)
		if err := check(a); err != nil {
			t.Fatalf("refused: %v", err)
		}
	})
	t.Run("no attestation at all", func(t *testing.T) {
		if err := check(newAuthority(t)); !errors.Is(err, errNoAttestation) {
			t.Fatalf("want errNoAttestation, got %v", err)
		}
	})
}
