package provenance

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	protodsse "github.com/sigstore/protobuf-specs/gen/pb-go/dsse"
	protorekor "github.com/sigstore/protobuf-specs/gen/pb-go/rekor/v1"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
	"google.golang.org/protobuf/proto"
)

// publication: what a registry holds of a released gateway, as ghcr holds
// it — the image's index under its tag and its digest, its attestations'
// index under the sha256-<hex> tag, and the attestation's manifest and
// bundle by digest — keyed by the path below the repository, with the
// authority that signed the attestation.
type publication struct {
	authority                    *authority
	digest                       string
	manifestDigest, bundleDigest string
	documents                    map[string][]byte
}

func publish(t *testing.T) publication {
	t.Helper()
	index := mustJSON(t, map[string]any{"schemaVersion": 2, "mediaType": ociIndex, "manifests": []any{}})
	digest := sha256Digest(index)
	a := newAuthority(t)
	a.digestOf = digest
	blob := bundleOf(t, a, servicesRelease, digest)
	bundleDigest := sha256Digest(blob)
	manifest := mustJSON(t, map[string]any{
		"schemaVersion": 2,
		"mediaType":     ociManifest,
		"artifactType":  sigstoreBundleV03,
		"layers":        []any{map[string]any{"mediaType": sigstoreBundleV03, "digest": bundleDigest, "size": len(blob)}},
		"subject":       map[string]any{"mediaType": ociIndex, "digest": digest, "size": len(index)},
	})
	manifestDigest := sha256Digest(manifest)
	referrers := mustJSON(t, map[string]any{
		"schemaVersion": 2,
		"mediaType":     ociIndex,
		"manifests":     []any{map[string]any{"mediaType": ociManifest, "digest": manifestDigest, "size": len(manifest), "artifactType": sigstoreBundleV03}},
	})
	return publication{
		authority:      a,
		digest:         digest,
		manifestDigest: manifestDigest,
		bundleDigest:   bundleDigest,
		documents: map[string][]byte{
			"/manifests/latest":    index,
			"/manifests/" + digest: index,
			"/manifests/" + strings.Replace(digest, ":", "-", 1): referrers,
			"/manifests/" + manifestDigest:                       manifest,
			"/blobs/" + bundleDigest:                             blob,
		},
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// bundleOf: build provenance of subject, signed for identity by the
// authority and written as the v0.3 bundle a registry serves.
func bundleOf(t *testing.T, a *authority, identity, subject string) []byte {
	t.Helper()
	statement := mustJSON(t, map[string]any{
		"_type":         "https://in-toto.io/Statement/v1",
		"subject":       []map[string]any{{"name": gatewayImage, "digest": map[string]string{"sha256": strings.TrimPrefix(subject, "sha256:")}}},
		"predicateType": buildProvenance,
		"predicate":     map[string]any{},
	})
	entity, err := a.ca.AttestAtTime(identity, githubActions, statement, time.Now().Add(5*time.Minute), true)
	if err != nil {
		t.Fatal(err)
	}
	content, err := entity.VerificationContent()
	if err != nil {
		t.Fatal(err)
	}
	signature, err := entity.SignatureContent()
	if err != nil {
		t.Fatal(err)
	}
	envelope := signature.EnvelopeContent().RawEnvelope()
	payload, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		t.Fatal(err)
	}
	var signatures []*protodsse.Signature
	for _, s := range envelope.Signatures {
		sig, err := base64.StdEncoding.DecodeString(s.Sig)
		if err != nil {
			t.Fatal(err)
		}
		signatures = append(signatures, &protodsse.Signature{Sig: sig, Keyid: s.KeyID})
	}
	entries, err := entity.TlogEntries()
	if err != nil {
		t.Fatal(err)
	}
	var tlog []*protorekor.TransparencyLogEntry
	for _, e := range entries {
		tle := proto.Clone(e.TransparencyLogEntry()).(*protorekor.TransparencyLogEntry)
		tle.KindVersion = &protorekor.KindVersion{Kind: "dsse", Version: "0.0.1"}
		tlog = append(tlog, tle)
	}
	stamps, err := entity.Timestamps()
	if err != nil {
		t.Fatal(err)
	}
	var rfc3161 []*protocommon.RFC3161SignedTimestamp
	for _, s := range stamps {
		rfc3161 = append(rfc3161, &protocommon.RFC3161SignedTimestamp{SignedTimestamp: s})
	}
	b, err := bundle.NewBundle(&protobundle.Bundle{
		MediaType: sigstoreBundleV03,
		VerificationMaterial: &protobundle.VerificationMaterial{
			Content:                   &protobundle.VerificationMaterial_Certificate{Certificate: &protocommon.X509Certificate{RawBytes: content.Certificate().Raw}},
			TlogEntries:               tlog,
			TimestampVerificationData: &protobundle.TimestampVerificationData{Rfc3161Timestamps: rfc3161},
		},
		Content: &protobundle.Bundle_DsseEnvelope{DsseEnvelope: &protodsse.Envelope{Payload: payload, PayloadType: envelope.PayloadType, Signatures: signatures}},
	})
	if err != nil {
		t.Fatal(err)
	}
	out, err := b.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// serve: a registry serving the publication as ghcr does, a pull token asked
// for at its realm first. tamper, when set, changes what is served for a
// path.
func serve(t *testing.T, p publication, tamper func(path string, body []byte) []byte) (*httptest.Server, string) {
	t.Helper()
	repo := "/v2/xynolog/xynolog-gateway"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			if r.URL.Query().Get("scope") != "repository:xynolog/xynolog-gateway:pull" {
				http.Error(w, "wrong scope", http.StatusBadRequest)
				return
			}
			fmt.Fprint(w, `{"token":"pull-token"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer pull-token" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="`+srv.URL+`/token",service="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, repo)
		body, ok := p.documents[path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if path == "/manifests/latest" || path == "/manifests/"+p.digest {
			w.Header().Set("Docker-Content-Digest", p.digest)
		}
		if tamper != nil {
			body = tamper(path, body)
		}
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv, strings.TrimPrefix(srv.URL, "http://") + "/xynolog/xynolog-gateway:latest"
}

// rooted: the registry, checked against the authority that signed what it
// serves.
type rooted struct {
	registry
	authority *authority
}

func (r rooted) trustedMaterial() (root.TrustedMaterial, []verify.VerifierOption, error) {
	return r.authority.trustedMaterial()
}

func TestTheRegistryServesWhatVerifies(t *testing.T) {
	p := publish(t)
	srv, image := serve(t, p, nil)
	digest, err := sigstoreVerifier{rooted{registry{client: srv.Client()}, p.authority}}.Verify(image, xynolog("publish-service-images.yml"))
	if err != nil {
		t.Fatalf("refused: %v", err)
	}
	if digest != p.digest {
		t.Errorf("verified %s, want %s", digest, p.digest)
	}
}

func TestTheRegistryIsNotTakenAtItsWord(t *testing.T) {
	flip := func(b []byte) []byte {
		out := append([]byte{}, b...)
		out[len(out)/2] ^= 1
		return out
	}
	p := publish(t)
	for _, c := range []struct {
		name, path string
		alter      func([]byte) []byte
		want       string
	}{
		{"a tampered bundle", "/blobs/" + p.bundleDigest, flip, "hashes to"},
		{"a tampered attestation manifest", "/manifests/" + p.manifestDigest, flip, "hashes to"},
		{"an index other than the one its digest names", "/manifests/latest", func(b []byte) []byte { return append(b, '\n') }, "hashes to"},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv, image := serve(t, p, func(path string, body []byte) []byte {
				if path == c.path {
					return c.alter(body)
				}
				return body
			})
			if digest, err := (sigstoreVerifier{rooted{registry{client: srv.Client()}, p.authority}}).Verify(image, xynolog("publish-service-images.yml")); err == nil {
				t.Fatalf("verified %s", digest)
			} else if !strings.Contains(err.Error(), c.want) {
				t.Errorf("want a refusal saying %q, got %v", c.want, err)
			}
		})
	}
}

func TestAnImageWithNoAttestationsTagHasNone(t *testing.T) {
	srv, image := serve(t, publish(t), nil)
	r := registry{client: srv.Client()}
	if _, err := r.attestations(image, "sha256:"+strings.Repeat("0", 64)); !errors.Is(err, errNoAttestation) {
		t.Fatalf("want errNoAttestation, got %v", err)
	}
}

func TestADigestInTheImageIsTheDigest(t *testing.T) {
	r := registry{client: &http.Client{Transport: noNetwork{}}}
	pinned := "sha256:" + strings.Repeat("2b", 32)
	digest, err := r.digest("ghcr.io/xynolog/xynolog-gateway:latest@" + pinned)
	if err != nil || digest != pinned {
		t.Fatalf("got %q, %v: an image pinned by its digest needs no registry to name it", digest, err)
	}
}

type noNetwork struct{}

func (noNetwork) RoundTrip(r *http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("asked %s", r.URL)
}

func TestAReferenceNamesItsRegistry(t *testing.T) {
	for _, c := range []struct{ image, base, tag, digest string }{
		{"ghcr.io/xynolog/xynolog-gateway:latest", "https://ghcr.io/v2/xynolog/xynolog-gateway", "latest", ""},
		{"busybox:1.38.0", "https://registry-1.docker.io/v2/library/busybox", "1.38.0", ""},
		{"qdrant/qdrant:v1.19.1", "https://registry-1.docker.io/v2/qdrant/qdrant", "v1.19.1", ""},
		{"quay.io/keycloak/keycloak:26.7.4@sha256:" + strings.Repeat("1", 64), "https://quay.io/v2/keycloak/keycloak", "26.7.4", "sha256:" + strings.Repeat("1", 64)},
		{"localhost:5000/xynolog-gateway:local", "http://localhost:5000/v2/xynolog-gateway", "local", ""},
		{"registry.localhost/xynolog-gateway:x", "http://registry.localhost/v2/xynolog-gateway", "x", ""},
		{"127.0.0.1:5000/a/b:c", "http://127.0.0.1:5000/v2/a/b", "c", ""},
	} {
		ref, err := parseReference(c.image)
		if err != nil {
			t.Errorf("%s: %v", c.image, err)
			continue
		}
		if ref.base() != c.base || ref.tag != c.tag || ref.digest != c.digest {
			t.Errorf("%s: %s, tag %q, digest %q; want %s, %q, %q", c.image, ref.base(), ref.tag, ref.digest, c.base, c.tag, c.digest)
		}
	}
	if _, err := parseReference("ghcr.io/xynolog/xynolog-gateway"); err == nil {
		t.Error("an image with neither tag nor digest was read as one")
	}
}
