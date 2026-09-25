package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	keyGot      = "5JMPeO7gXIbR5CnUa/NPNK4L5GqUnreF0/Bozai4pl4="
	ipGot       = "185.213.154.66"
	keyNYC      = "IzqkjVCdJYC1AShILfzebchTlKCqVCt/SMEXolaS3Uc="
	ipNYC       = "146.70.165.2"
	keyInactive = "gg5+xEYxjDYGeTEWrDM6wXmq4Q1Lx6kBsn6mm3u8VhU="
	ipInactive  = "146.70.165.130"
	ipBridge    = "185.213.154.117" // listed, but only as a bridge relay
	keyRandom   = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
)

func fixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/relays.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func ap(s string) netip.AddrPort { return netip.MustParseAddrPort(s) }

func TestRelayListCheck(t *testing.T) {
	l, err := parseRelayList(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name    string
		key, ep string
		wantErr string // "" = accept
	}{
		{"listed relay, default port", keyGot, ipGot + ":51820", ""},
		{"listed relay, other advertised port", keyNYC, ipNYC + ":53", ""},
		{"listed relay, port range low edge", keyNYC, ipNYC + ":4000", ""},
		{"listed relay, port range high edge", keyNYC, ipNYC + ":60000", ""},
		{"right key, another relay's IP", keyGot, ipNYC + ":51820", "not the address"},
		{"right key, unlisted IP", keyGot, "198.51.100.7:51820", "not the address"},
		{"right key, relay's shadowsocks extra IP", keyGot, "185.213.154.70:51820", "not the address"},
		{"random key, listed IP", keyRandom, ipGot + ":51820", "not a listed"},
		{"random key, unlisted IP", keyRandom, "198.51.100.7:51820", "not a listed"},
		{"port in gap between ranges", keyGot, ipGot + ":33500", "port"},
		{"port above ranges", keyGot, ipGot + ":60001", "port"},
		{"port 443", keyGot, ipGot + ":443", "port"},
		{"inactive relay", keyInactive, ipInactive + ":51820", "not active"},
		{"bridge relay IP (not wireguard)", keyGot, ipBridge + ":51820", "not the address"},
		{"bridge relay IP, random key", keyRandom, ipBridge + ":51820", "not a listed"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := l.check(c.key, ap(c.ep))
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("want accept, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}
}

func TestParseRelayList(t *testing.T) {
	bad := map[string]string{
		"not json":             `<html>`,
		"no wireguard section": `{"openvpn":{"relays":[]}}`,
		"no wireguard relays":  `{"wireguard":{"relays":[],"port_ranges":[[51820,51820]]}}`,
		"wrong types":          `{"wireguard":{"relays":[{"public_key":1}]}}`,
	}
	for name, body := range bad {
		if _, err := parseRelayList([]byte(body)); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}

	// No usable port info → only the standard 51820.
	for _, pr := range []string{``, `,"port_ranges":[]`, `,"port_ranges":[[0,0],[5,1],[1],[1,70000]]`} {
		body := `{"wireguard":{"relays":[{"hostname":"x","active":true,"ipv4_addr_in":"` + ipGot + `","public_key":"` + keyGot + `"}]` + pr + `}}`
		l, err := parseRelayList([]byte(body))
		if err != nil {
			t.Fatalf("%q: %v", pr, err)
		}
		if err := l.check(keyGot, ap(ipGot+":51820")); err != nil {
			t.Errorf("%q: 51820 refused: %v", pr, err)
		}
		if err := l.check(keyGot, ap(ipGot+":53")); err == nil {
			t.Errorf("%q: 53 accepted without port info", pr)
		}
	}
}

func TestCheckTunnelAddress(t *testing.T) {
	for _, s := range []string{"10.64.37.199/32", "10.69.123.45/32", "10.127.255.254/32"} {
		if _, err := checkTunnelAddress(s); err != nil {
			t.Errorf("%s refused: %v", s, err)
		}
	}
	for _, s := range []string{
		"10.64.37.199/24", "172.17.0.5/16", "10.128.0.1/32", "192.168.1.2/32",
		"10.64.0.1/32", "010.64.0.2/32", "10.64.0.2", "0.0.0.0/0",
	} {
		if _, err := checkTunnelAddress(s); err == nil {
			t.Errorf("%s accepted", s)
		}
	}
}

// fakeMullvad serves the relay list over TLS with a certificate for
// api.mullvad.net from a private CA, so the production URL and ServerName
// are exercised unchanged; only the dial addresses and roots differ.
type fakeMullvad struct {
	srv   *httptest.Server
	pool  *x509.CertPool
	hits  atomic.Int32
	serve atomic.Value // func(http.ResponseWriter)
	clock time.Time
}

func newFakeMullvad(t *testing.T, certHost string) *fakeMullvad {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: certHost},
		DNSNames:              []string{certHost},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	f := &fakeMullvad{pool: x509.NewCertPool(), clock: time.Unix(1_800_000_000, 0)}
	f.pool.AddCert(cert)
	body := fixture(t)
	f.serve.Store(func(w http.ResponseWriter) { w.Write(body) })
	f.srv = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if r.URL.Path != "/app/v1/relays" || r.Host != relayAPIHost {
			http.NotFound(w, r)
			return
		}
		f.serve.Load().(func(http.ResponseWriter))(w)
	}))
	f.srv.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	f.srv.StartTLS()
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMullvad) verifier() *relayVerifier {
	v := newRelayVerifier() // production URL
	v.rootCAs = f.pool
	v.now = func() time.Time { return f.clock }
	return v
}

func (f *fakeMullvad) addrs() ([]string, error) {
	return []string{f.srv.Listener.Addr().String()}, nil
}

func TestVerifierFetchAndCache(t *testing.T) {
	f := newFakeMullvad(t, relayAPIHost)
	v := f.verifier()

	if err := v.verify(keyGot, ap(ipGot+":51820"), f.addrs); err != nil {
		t.Fatalf("listed relay refused: %v", err)
	}
	if err := v.verify(keyGot, ap(ipNYC+":51820"), f.addrs); err == nil {
		t.Fatal("wrong IP accepted")
	}
	if err := v.verify(keyRandom, ap("198.51.100.7:51820"), f.addrs); err == nil {
		t.Fatal("unlisted endpoint accepted")
	}
	if n := f.hits.Load(); n != 1 {
		t.Fatalf("fresh-cache rejections refetched: %d fetches", n)
	}

	// A relay that appears after our fetch: refused while the cache is
	// under a minute old, accepted after one refetch once it's older.
	newKey := "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="
	updated := strings.Replace(string(fixture(t)), keyInactive, newKey, 1)
	updated = strings.Replace(updated, `"active": false`, `"active": true`, 1)
	f.serve.Store(func(w http.ResponseWriter) { w.Write([]byte(updated)) })
	if err := v.verify(newKey, ap(ipInactive+":51820"), f.addrs); err == nil {
		t.Fatal("unknown relay accepted from a cache that doesn't list it")
	}
	f.clock = f.clock.Add(2 * time.Minute)
	if err := v.verify(newKey, ap(ipInactive+":51820"), f.addrs); err != nil {
		t.Fatalf("new relay refused after refetch: %v", err)
	}
	if n := f.hits.Load(); n != 2 {
		t.Fatalf("want 2 fetches, got %d", n)
	}

	// Within the TTL a known relay needs no fetch, even with the API down.
	f.serve.Store(func(w http.ResponseWriter) { w.WriteHeader(http.StatusServiceUnavailable) })
	f.clock = f.clock.Add(5 * time.Minute)
	if err := v.verify(keyGot, ap(ipGot+":51820"), f.addrs); err != nil {
		t.Fatalf("cached relay refused: %v", err)
	}
	// Past the TTL the list must be refetched; failure → refuse.
	f.clock = f.clock.Add(relayListTTL)
	if err := v.verify(keyGot, ap(ipGot+":51820"), f.addrs); err == nil {
		t.Fatal("accepted with an expired cache and a failing API")
	}
}

func TestVerifierFailsClosed(t *testing.T) {
	good := ap(ipGot + ":51820")
	cases := []struct {
		name    string
		wantErr string
		setup   func(f *fakeMullvad, v *relayVerifier) func() ([]string, error)
	}{
		{"HTTP 500", "HTTP 500", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			f.serve.Store(func(w http.ResponseWriter) { w.WriteHeader(500) })
			return f.addrs
		}},
		{"oversized body", "larger than", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			body := fixture(t)
			f.serve.Store(func(w http.ResponseWriter) {
				// Valid JSON followed by padding past the limit, streamed
				// without a Content-Length.
				w.Write(body)
				pad := []byte(strings.Repeat(" ", 64<<10))
				for n := 0; n <= maxRelayListBytes; n += len(pad) {
					if _, err := w.Write(pad); err != nil {
						return
					}
				}
			})
			return f.addrs
		}},
		{"oversized Content-Length", "too large", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			f.serve.Store(func(w http.ResponseWriter) {
				w.Header().Set("Content-Length", "9000000")
				w.Write(fixture(t))
			})
			return f.addrs
		}},
		{"garbage body", "parse relay list", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			f.serve.Store(func(w http.ResponseWriter) { w.Write([]byte("<html>captive portal</html>")) })
			return f.addrs
		}},
		{"no pinned addresses", "has not been routed", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			return func() ([]string, error) { return nil, errors.New("api.mullvad.net has not been routed") }
		}},
		{"nothing listening", "connection refused", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			return func() ([]string, error) { return []string{"127.0.0.1:1"}, nil }
		}},
		{"untrusted certificate", "certificate", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			v.rootCAs = x509.NewCertPool()
			return f.addrs
		}},
		{"redirect", "redirect refused", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			f.serve.Store(func(w http.ResponseWriter) {
				w.Header().Set("Location", "https://evil.example/relays")
				w.WriteHeader(http.StatusFound)
			})
			return f.addrs
		}},
		{"plain http URL", "invalid relay list URL", func(f *fakeMullvad, v *relayVerifier) func() ([]string, error) {
			v.url = "http://api.mullvad.net/app/v1/relays"
			return f.addrs
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeMullvad(t, relayAPIHost)
			v := f.verifier()
			dial := c.setup(f, v)
			err := v.verify(keyGot, good, dial)
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("want error containing %q, got %v", c.wantErr, err)
			}
		})
	}

	// A certificate for another name is refused even from the pinned address.
	t.Run("certificate for another host", func(t *testing.T) {
		f := newFakeMullvad(t, "evil.example")
		err := f.verifier().verify(keyGot, good, f.addrs)
		if err == nil || !strings.Contains(err.Error(), "not api.mullvad.net") {
			t.Fatalf("want a certificate name error, got %v", err)
		}
	})
}
