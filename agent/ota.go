package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"os"
)

// MaybeUpdate checks for and, if authorized + verified, installs a new agent
// binary, then exits so the service manager restarts the fresh version.
func MaybeUpdate(client *Client, cfg *Config) {
	upd, err := client.CheckUpdate(AgentVersion)
	if err != nil {
		log.Printf("ota: check failed: %v", err)
		return
	}
	if !upd.UpdateAvailable {
		return
	}
	log.Printf("ota: update available %s -> %s", AgentVersion, upd.Version)

	tmp := "/tmp/screenboard-agent.new"
	if err := client.DownloadTo(upd.URL, tmp); err != nil {
		log.Printf("ota: download failed: %v", err)
		return
	}
	defer os.Remove(tmp)

	data, err := os.ReadFile(tmp)
	if err != nil {
		log.Printf("ota: read failed: %v", err)
		return
	}

	sum := sha256.Sum256(data)
	checksum := hex.EncodeToString(sum[:])
	if checksum != upd.Checksum {
		log.Printf("ota: checksum mismatch, aborting")
		return
	}
	if err := verifySignature(cfg.OTAPublicKey, upd.Checksum, upd.Signature); err != nil {
		log.Printf("ota: signature verification failed: %v", err)
		return
	}

	self, err := os.Executable()
	if err != nil {
		log.Printf("ota: cannot locate self: %v", err)
		return
	}
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		log.Printf("ota: chmod failed: %v", err)
		return
	}
	// Replace the running binary and exit; systemd (Restart=always) relaunches it.
	if err := os.Rename(tmp, self); err != nil {
		log.Printf("ota: replace failed: %v", err)
		return
	}
	log.Printf("ota: installed %s, restarting", upd.Version)
	os.Exit(0)
}

// verifySignature checks an ed25519 signature over the checksum hex string.
// If no public key is configured, signature verification is skipped (checksum
// still enforced).
func verifySignature(pubB64, checksumHex, sigB64 string) error {
	if pubB64 == "" {
		log.Printf("ota: no OTA public key configured, skipping signature check")
		return nil
	}
	pub, err := base64.StdEncoding.DecodeString(pubB64)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public key")
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("invalid signature encoding")
	}
	if !ed25519.Verify(ed25519.PublicKey(pub), []byte(checksumHex), sig) {
		return fmt.Errorf("signature does not verify")
	}
	return nil
}
