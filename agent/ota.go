package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
)

// updateHelper is a small root-owned script (installed by install.sh) that
// atomically swaps in a new agent binary. The kiosk Agent runs unprivileged and
// its binary lives in a root-owned directory, so it cannot replace itself
// directly; it stages the verified binary and asks the helper — through a
// narrow, password-less sudoers rule — to install it as root.
const updateHelper = "/usr/local/bin/screenboard-apply-update"

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

	staged := "/tmp/screenboard-agent.new"
	if err := client.DownloadTo(upd.URL, staged); err != nil {
		log.Printf("ota: download failed: %v", err)
		return
	}
	defer os.Remove(staged)

	data, err := os.ReadFile(staged)
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
	if err := os.Chmod(staged, 0o755); err != nil {
		log.Printf("ota: chmod failed: %v", err)
		return
	}

	if err := installBinary(staged, data); err != nil {
		log.Printf("ota: install failed: %v", err)
		return
	}
	log.Printf("ota: installed %s, restarting", upd.Version)
	os.Exit(0)
}

// installBinary swaps the running executable for the staged one. It prefers the
// privileged helper (the normal case: unprivileged agent, root-owned binary
// directory) and falls back to a same-filesystem atomic replace for setups
// where the agent can write its own directory (e.g. it runs as root, or the
// binary sits in a user-owned directory).
func installBinary(staged string, data []byte) error {
	helperErr := runUpdateHelper(staged)
	if helperErr == nil {
		return nil
	}
	if err := sameDirReplace(data); err != nil {
		return fmt.Errorf("helper: %v; direct replace: %v", helperErr, err)
	}
	return nil
}

// runUpdateHelper asks the root-owned helper to install the staged binary via
// the password-less sudo rule that install.sh grants the kiosk user.
func runUpdateHelper(staged string) error {
	if _, err := exec.LookPath("sudo"); err != nil {
		return fmt.Errorf("sudo unavailable: %w", err)
	}
	cmd := exec.Command("sudo", "-n", updateHelper, staged)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

// sameDirReplace writes the new binary into the directory of the running
// executable and atomically renames it over the current file. Staging in the
// same directory keeps the rename on one filesystem (no EXDEV) and atomic, but
// requires write access to that directory.
func sameDirReplace(data []byte) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	tmp, err := os.CreateTemp(filepath.Dir(self), ".screenboard-agent.new-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below succeeds
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	return os.Rename(tmpName, self)
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
