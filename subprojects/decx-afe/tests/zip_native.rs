//! Native zip/jar reader tests: DEFLATE decoding, central-directory
//! parsing and the stored writer. The expected payloads below were produced
//! with zlib level 9 (raw DEFLATE), so the fixtures stay independent of this
//! crate's own compressor-free writer.

use std::path::PathBuf;

use afe::zip::{
    crc32, create_zip_archive, encode_zip, extract_zip_entry, inflate_raw, list_zip_entries,
    read_zip_entry_text, ZipArchive,
};

/// Raw deflate stream for `hello hello hello hello\n` (fixed Huffman).
const FIXED_DEFLATE: &str = "cb48cdc9c957c84027b900";

/// Raw deflate stream for the 3000-byte dynamic payload (dynamic Huffman).
const DYNAMIC_DEFLATE: &str = "4dd2d75b0e001c406192a2924d4619c92c899095d550f64a0a453469532942194584b277999191591192480b95acac22a38506572ebedff338ffc0b9396f2355cdf65d75fb1b998cb5983a678193bb4f60e8a6a8988327ce5eba99f630a7e0f5c7afd5f54dd45a77eade67e0d0d113ad67da3a38af58191216b973dfd15317aea6dc7ffcb4f8dde78adf8d1499c123c6594e9b2b99edb187e2ce5d96ccb79a0665f53692993c6bbea38ba7644e275e4b4dcf924cb3961db47b0d90cc520fdfa0759b25733733b7f0cd27c9f4e86b386c8c9964d6846fddb5ff98645ebeff5259db583223c74f9a6eb350327b0ec7275cb925999f7f9a6ab4ed2c99d9768b5dbd5649e6e2f5db0f9e3c934cab8e3a7afa4324b3dc6ff5fa2d3b24f328afe86de977c9f41b34dcd47c8a64366edb7de0f819c97c28afaa536a2e99095633e62d5a26992327cf2725df93cc5f9516edbaf4948cfd1237ef80b592b9712723fbf92bc96875eb6d603c4a32fec11b22a2f74a26ff4549d98f5f9251cc948c62a664143325a3982919c54cc9d0843d4ddca0092d9af0a7897c9a30a289289af84a13d634718a265469c28926d268a23b4d84d044314d8ca089589aa8a18959349148132d69c283263269a22f4d84d3c47b9a184f138769e20f4dd8d1c4759ae848137e349147138368621b4d94d384154d9ca409159a5842137768a21b4d04d3c40b9a30a189189aa8a68999347181263469c29d261ed2441f9a08a3897734318e260ed144034dcca7896b34d181267c692297260c69622b4d7ca1894934114f134d6962314ddca6091d9a584d134534319c2676d344154dcca089f334d18226dc682283267ad3c4069a28a189b134719026ea69c29626aed2447b9af0a1891c9a1848139134f199262c69228e269469c291265269429b268268a2902686d1c42e9aa8a489e9349140131a34e14a130f68428f26d6d3c45b9a30a5890334514713f368228926dad184374d64d384014d44d044194d58d0c4099a6842130e349142135d692290260a6862284deca4890a9a984613e768429d265c68229d267ad1c43a9a7843136368623f4dd4d2840d4d5ca189b634e145134f68429f26b6d044294d98d3c4719a50a2894534914c135d682280269ed384314d44d3c40f9a984a136769428d269c69e23e4de8d244284dbca689d134b18f267ed3c45c9ab84c136d68c29326b26862004d6ca6894f3461f6dfc43f";

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn dynamic_plaintext() -> Vec<u8> {
    (0..3000).map(|i| ((i * 7 + i / 13) % 251) as u8).collect()
}

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "afe-zip-{}-{}-{}",
        label,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Build a single-entry zip whose entry uses `method` and payload `data`.
fn build_zip(name: &str, plain: &[u8], data: &[u8], method: u16) -> Vec<u8> {
    let mut out = Vec::new();
    let name_bytes = name.as_bytes();
    let crc = crc32(plain);
    push_u32(&mut out, LOCAL_SIG);
    push_u16(&mut out, 20);
    push_u16(&mut out, 0);
    push_u16(&mut out, method);
    push_u16(&mut out, 0);
    push_u16(&mut out, 0x0021);
    push_u32(&mut out, crc);
    push_u32(&mut out, data.len() as u32);
    push_u32(&mut out, plain.len() as u32);
    push_u16(&mut out, name_bytes.len() as u16);
    push_u16(&mut out, 0);
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(data);

    let central_offset = out.len() as u32;
    let mut central = Vec::new();
    push_u32(&mut central, CENTRAL_SIG);
    push_u16(&mut central, 20);
    push_u16(&mut central, 20);
    push_u16(&mut central, 0);
    push_u16(&mut central, method);
    push_u16(&mut central, 0);
    push_u16(&mut central, 0x0021);
    push_u32(&mut central, crc);
    push_u32(&mut central, data.len() as u32);
    push_u32(&mut central, plain.len() as u32);
    push_u16(&mut central, name_bytes.len() as u16);
    push_u16(&mut central, 0);
    push_u16(&mut central, 0);
    push_u16(&mut central, 0);
    push_u16(&mut central, 0);
    push_u32(&mut central, 0);
    push_u32(&mut central, 0);
    central.extend_from_slice(name_bytes);
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);

    push_u32(&mut out, EOCD_SIG);
    push_u16(&mut out, 0);
    push_u16(&mut out, 0);
    push_u16(&mut out, 1);
    push_u16(&mut out, 1);
    push_u32(&mut out, central_size);
    push_u32(&mut out, central_offset);
    push_u16(&mut out, 0);
    out
}

#[test]
fn inflates_fixed_huffman_block() {
    let decoded = inflate_raw(&hex_decode(FIXED_DEFLATE)).unwrap();
    assert_eq!(decoded, b"hello hello hello hello\n".to_vec());
}

#[test]
fn inflates_dynamic_huffman_block() {
    let decoded = inflate_raw(&hex_decode(DYNAMIC_DEFLATE)).unwrap();
    assert_eq!(decoded, dynamic_plaintext());
}

#[test]
fn inflates_stored_block() {
    // bfinal=1, btype=00, aligned LEN/NLEN, then raw bytes.
    let plain = b"stored block payload".to_vec();
    let mut stream = vec![0x01];
    stream.extend_from_slice(&(plain.len() as u16).to_le_bytes());
    stream.extend_from_slice(&(!(plain.len() as u16)).to_le_bytes());
    stream.extend_from_slice(&plain);
    assert_eq!(inflate_raw(&stream).unwrap(), plain);
}

#[test]
fn rejects_bad_stored_block_length() {
    let mut stream = vec![0x01, 0x05, 0x00, 0x00, 0x00, b'a', b'b'];
    stream.push(0);
    assert!(inflate_raw(&stream).is_err());
}

#[test]
fn round_trips_stored_entries() {
    let entries = vec![
        (
            "META-INF/MANIFEST.MF".to_string(),
            b"Manifest-Version: 1.0".to_vec(),
        ),
        ("classes.dex".to_string(), (0..=255u8).collect::<Vec<u8>>()),
    ];
    let blob = encode_zip(&entries).unwrap();
    let archive = ZipArchive::from_bytes("memory.zip", blob);
    assert_eq!(
        archive.names().unwrap(),
        vec![
            "META-INF/MANIFEST.MF".to_string(),
            "classes.dex".to_string()
        ]
    );
    for (name, content) in &entries {
        assert_eq!(&archive.read_name(name).unwrap().unwrap(), content);
    }
    assert!(archive.read_name("missing.dex").unwrap().is_none());
}

#[test]
fn reads_deflate_entries() {
    let plain = b"hello hello hello hello\n".to_vec();
    let blob = build_zip("payload.dex", &plain, &hex_decode(FIXED_DEFLATE), 8);
    let archive = ZipArchive::from_bytes("deflate.zip", blob);
    assert_eq!(archive.read_name("payload.dex").unwrap().unwrap(), plain);
}

#[test]
fn detects_crc_mismatch() {
    let entries = vec![("classes.dex".to_string(), b"payload".to_vec())];
    let mut blob = encode_zip(&entries).unwrap();
    let data_offset = 30 + "classes.dex".len() + local_extra_len(&blob);
    blob[data_offset] ^= 0xff;
    let archive = ZipArchive::from_bytes("broken.zip", blob);
    let error = archive.read_name("classes.dex").unwrap_err();
    assert!(error.message.contains("CRC mismatch"), "{}", error.message);
}

fn local_extra_len(blob: &[u8]) -> usize {
    u16::from_le_bytes([blob[28], blob[29]]) as usize
}

#[test]
fn rejects_unknown_compression_method() {
    let plain = b"payload".to_vec();
    let blob = build_zip("payload.dex", &plain, &plain, 12);
    let archive = ZipArchive::from_bytes("bzip2.zip", blob);
    let error = archive.read_name("payload.dex").unwrap_err();
    assert!(
        error.message.contains("unsupported compression method 12"),
        "{}",
        error.message
    );
}

#[test]
fn rejects_truncated_archives() {
    assert!(ZipArchive::from_bytes("tiny.zip", vec![0u8; 8])
        .entries()
        .is_err());
    let blob = build_zip("payload.dex", b"payload", b"payload", 0);
    let truncated = blob[..blob.len() - 10].to_vec();
    assert!(ZipArchive::from_bytes("truncated.zip", truncated)
        .entries()
        .is_err());
}

#[test]
fn writes_and_reads_archives_on_disk() {
    let dir = temp_dir("disk");
    std::fs::create_dir_all(dir.join("META-INF")).unwrap();
    std::fs::write(dir.join("META-INF/MANIFEST.MF"), b"Manifest-Version: 1.0\n").unwrap();
    std::fs::write(dir.join("classes.dex"), b"dex-bytes").unwrap();
    let archive_path = dir.join("framework.jar").to_str().unwrap().to_string();
    create_zip_archive(
        &archive_path,
        &["META-INF".to_string(), "classes.dex".to_string()],
        &dir,
    )
    .unwrap();

    assert_eq!(
        list_zip_entries(&archive_path).unwrap(),
        vec![
            "META-INF/".to_string(),
            "META-INF/MANIFEST.MF".to_string(),
            "classes.dex".to_string()
        ]
    );
    assert_eq!(
        read_zip_entry_text(&archive_path, "META-INF/MANIFEST.MF").unwrap(),
        "Manifest-Version: 1.0\n"
    );
    let target = dir.join("extracted.dex");
    extract_zip_entry(&archive_path, "classes.dex", target.to_str().unwrap()).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"dex-bytes");

    let missing = extract_zip_entry(&archive_path, "nope.dex", "/dev/null/never").unwrap_err();
    assert!(
        missing.message.contains("no such entry"),
        "{}",
        missing.message
    );

    std::fs::remove_dir_all(&dir).ok();
}
