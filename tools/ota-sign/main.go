// ota-sign: generate an ed25519 keypair and sign OTA package checksums.
//
//	go run . keygen
//	  -> prints base64 public + private keys. Put the public key in each agent's
//	     config (ota_public_key) and keep the private key secret.
//
//	go run . sign <checksum-hex> <private-key-b64>
//	  -> prints the base64 signature to pass as ?signature= when uploading the
//	     OTA package. The server stores the sha256 checksum; the agent verifies
//	     this signature over that checksum hex string.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fail(err)
		}
		fmt.Println("public_key: ", base64.StdEncoding.EncodeToString(pub))
		fmt.Println("private_key:", base64.StdEncoding.EncodeToString(priv))
	case "sign":
		if len(os.Args) != 4 {
			usage()
		}
		checksumHex := os.Args[2]
		priv, err := base64.StdEncoding.DecodeString(os.Args[3])
		if err != nil || len(priv) != ed25519.PrivateKeySize {
			fail(fmt.Errorf("invalid private key"))
		}
		sig := ed25519.Sign(ed25519.PrivateKey(priv), []byte(checksumHex))
		fmt.Println(base64.StdEncoding.EncodeToString(sig))
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ota-sign keygen | ota-sign sign <checksum-hex> <private-key-b64>")
	os.Exit(2)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
