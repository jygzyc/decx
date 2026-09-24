//! SHA-256 (FIPS 180-4) via the `sha2` crate.
//!
//! Only used to derive a short, stable digest for nested zip entry names
//! (`<8 hex chars>_classes.dex`), matching the digest the TypeScript
//! implementation produced with `crypto.createHash("sha256")`.

use sha2::{Digest, Sha256};

/// SHA-256 digest of `data`.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Lowercase hex digest.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = sha256(data);
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

/// First eight hex characters of the digest.
pub fn sha256_prefix8(data: &[u8]) -> String {
    sha256_hex(data)[..8].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        // Multi-block input (spans several 64-byte chunks).
        let long = vec![b'a'; 1000];
        assert_eq!(
            sha256_hex(&long),
            "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
        );
    }

    #[test]
    fn prefix_is_eight_hex_chars() {
        let prefix = sha256_prefix8(b"classes.dex");
        assert_eq!(prefix.len(), 8);
        assert!(prefix.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_eq!(prefix, &sha256_hex(b"classes.dex")[..8]);
    }
}
