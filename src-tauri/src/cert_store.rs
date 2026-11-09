//! Certificados del almacén «Personal» de Windows (FNMT, DNIe, tarjetas…) para firmar PDF.
//!
//! La clave privada nunca sale de Windows: se le pide que firme el resumen y, si la clave está
//! en una tarjeta o tiene contraseña, es Windows (o el controlador de la tarjeta) quien pide el PIN.

use std::ffi::c_void;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Security::Cryptography::*;

use crate::pdf_sign::{cert_parts, ecdsa_der, Key};

/// El usuario cerró la ventana del PIN: no es un error que haya que mostrar.
pub const CANCELLED: &str = "Firma cancelada";

const ENCODING: u32 = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;

/// Usos ampliados con los que un certificado sirve para firmar documentos.
const SIGNING_EKUS: [&str; 6] = [
    "1.3.6.1.5.5.7.3.2",       // autenticación de cliente (FNMT)
    "1.3.6.1.5.5.7.3.4",       // correo seguro
    "1.3.6.1.5.5.7.3.36",      // firma de documentos (RFC 9336)
    "1.3.6.1.4.1.311.10.3.12", // firma de documentos (Microsoft)
    "1.2.840.113583.1.1.5",    // Adobe Authentic Documents Trust
    "2.5.29.37.0",             // cualquier uso
];

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CertInfo {
    /// Huella SHA-1 en hexadecimal: identifica el certificado al firmar.
    pub id: String,
    pub name: String,
    pub issuer: String,
    /// Validez, en milisegundos desde 1970.
    pub valid_from: i64,
    pub valid_to: i64,
    /// Es un certificado de firma (no repudio), como el «FIRMA» del DNIe.
    pub signing: bool,
    /// La clave está en una tarjeta (DNIe o tarjeta criptográfica).
    pub card: bool,
}

struct Store(HCERTSTORE);

impl Drop for Store {
    fn drop(&mut self) {
        unsafe { CertCloseStore(self.0, 0) };
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

fn open_my() -> Result<Store, String> {
    let name = wide("MY");
    let store = unsafe {
        CertOpenStore(
            CERT_STORE_PROV_SYSTEM_W,
            0,
            0,
            CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG,
            name.as_ptr() as *const c_void,
        )
    };
    if store.is_null() {
        return Err(win_error("No se ha podido abrir el almacén de certificados de Windows", unsafe { GetLastError() }));
    }
    Ok(Store(store))
}

/// Mensaje para un código de error de Windows (los de tarjeta, en palabras).
fn win_error(what: &str, code: u32) -> String {
    match code {
        0x0000_04C7 | 0x8007_04C7 | 0x8010_006E => CANCELLED.into(),
        0x8010_006B => "El PIN no es correcto".into(),
        0x8010_006C => "La tarjeta está bloqueada por demasiados intentos de PIN".into(),
        0x8010_000C | 0x8010_0069 | 0x8010_0066 => "No se encuentra la tarjeta: comprueba que está bien metida en el lector".into(),
        0x8009_0016 => format!("{what}: no se encuentra la clave del certificado (si está en una tarjeta, métela en el lector)"),
        _ => format!("{what} (código 0x{code:08X})"),
    }
}

unsafe fn property(ctx: *const CERT_CONTEXT, id: u32) -> Option<Vec<u64>> {
    let mut size = 0u32;
    if CertGetCertificateContextProperty(ctx, id, null_mut(), &mut size) == 0 || size == 0 {
        return None;
    }
    // u64 para que la estructura quede alineada.
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    if CertGetCertificateContextProperty(ctx, id, buf.as_mut_ptr() as *mut c_void, &mut size) == 0 {
        return None;
    }
    Some(buf)
}

unsafe fn pwstr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let len = (0..).take_while(|&i| *p.add(i) != 0).count();
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

unsafe fn name_string(ctx: *const CERT_CONTEXT, flags: u32) -> String {
    let mut buf = [0u16; 512];
    let n = CertGetNameStringW(ctx, CERT_NAME_SIMPLE_DISPLAY_TYPE, flags, null(), buf.as_mut_ptr(), buf.len() as u32);
    String::from_utf16_lossy(&buf[..(n as usize).saturating_sub(1)])
}

fn filetime_ms(ft: windows_sys::Win32::Foundation::FILETIME) -> i64 {
    let t = ((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64;
    (t - 116_444_736_000_000_000) / 10_000
}

/// Los usos ampliados permiten firmar (o el certificado no los limita).
unsafe fn eku_allows_signing(ctx: *const CERT_CONTEXT) -> bool {
    let mut size = 0u32;
    if CertGetEnhancedKeyUsage(ctx, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, null_mut(), &mut size) == 0 {
        return true; // sin la extensión: vale para todo
    }
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    let usage = buf.as_mut_ptr() as *mut CTL_USAGE;
    if CertGetEnhancedKeyUsage(ctx, CERT_FIND_EXT_ONLY_ENHKEY_USAGE_FLAG, usage, &mut size) == 0 {
        return true;
    }
    let usage = &*usage;
    if usage.cUsageIdentifier == 0 {
        return true;
    }
    (0..usage.cUsageIdentifier as usize).any(|i| {
        let p = *usage.rgpszUsageIdentifier.add(i);
        let oid = std::ffi::CStr::from_ptr(p as *const std::ffi::c_char).to_string_lossy();
        SIGNING_EKUS.contains(&oid.as_ref())
    })
}

/// Datos de un certificado del almacén, si sirve para firmar.
unsafe fn describe(ctx: *const CERT_CONTEXT) -> Option<CertInfo> {
    let prov = property(ctx, CERT_KEY_PROV_INFO_PROP_ID)?; // sin clave privada no se puede firmar
    let prov = &*(prov.as_ptr() as *const CRYPT_KEY_PROV_INFO);
    let provider = pwstr(prov.pwszProvName).to_lowercase();
    let info = &*(*ctx).pCertInfo;
    let mut usage = [0u8; 2];
    let limited = CertGetIntendedKeyUsage(ENCODING, info, usage.as_mut_ptr(), 2) != 0;
    // digitalSignature (0x80) o nonRepudiation (0x40)
    if limited && usage[0] & 0xC0 == 0 {
        return None;
    }
    if !eku_allows_signing(ctx) {
        return None;
    }
    let issuer = name_string(ctx, CERT_NAME_ISSUER_FLAG);
    if is_windows_internal(&issuer) {
        return None;
    }
    let mut hash = [0u8; 20];
    let mut size = 20u32;
    if CertGetCertificateContextProperty(ctx, CERT_SHA1_HASH_PROP_ID, hash.as_mut_ptr() as *mut c_void, &mut size) == 0 {
        return None;
    }
    Some(CertInfo {
        id: hash.iter().map(|b| format!("{b:02x}")).collect(),
        name: name_string(ctx, 0),
        issuer,
        valid_from: filetime_ms(info.NotBefore),
        valid_to: filetime_ms(info.NotAfter),
        signing: limited && usage[0] & 0x40 != 0,
        card: ["smart card", "dnie", "card", "tarjeta"].iter().any(|k| provider.contains(k)),
    })
}

/// Certificados que crea Windows para sí mismo (inicio de sesión con la cuenta de la empresa,
/// Windows Hello…): su emisor es un GUID o «MS-Organization-…». No sirven para firmar documentos.
fn is_windows_internal(issuer: &str) -> bool {
    let guid = issuer.len() == 36
        && issuer.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() });
    guid || issuer.starts_with("MS-Organization")
}

/// Certificados con clave privada que sirven para firmar: primero los de firma, luego por nombre.
pub fn list() -> Result<Vec<CertInfo>, String> {
    let store = open_my()?;
    let mut out = Vec::new();
    unsafe {
        let mut ctx: *mut CERT_CONTEXT = null_mut();
        loop {
            ctx = CertEnumCertificatesInStore(store.0, ctx);
            if ctx.is_null() {
                break;
            }
            if let Some(info) = describe(ctx) {
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| b.signing.cmp(&a.signing).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Clave de un certificado del almacén.
pub struct StoreKey {
    ctx: *const CERT_CONTEXT,
    cert: Vec<u8>,
    chain: Vec<Vec<u8>>,
    ec: bool,
    /// Ventana sobre la que Windows muestra la petición del PIN (0: ninguna).
    hwnd: isize,
}

impl Drop for StoreKey {
    fn drop(&mut self) {
        unsafe { CertFreeCertificateContext(self.ctx) };
    }
}

/// Abre el certificado con la huella `id` (SHA-1 en hexadecimal).
pub fn open_key(id: &str, hwnd: isize) -> Result<StoreKey, String> {
    let hash: Vec<u8> = (0..id.len())
        .step_by(2)
        .map(|i| id.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect::<Option<_>>()
        .filter(|h: &Vec<u8>| h.len() == 20)
        .ok_or("Certificado no válido")?;
    let store = open_my()?;
    unsafe {
        let blob = CRYPT_INTEGER_BLOB { cbData: 20, pbData: hash.as_ptr() as *mut u8 };
        let ctx = CertFindCertificateInStore(store.0, ENCODING, 0, CERT_FIND_SHA1_HASH, &blob as *const _ as *const c_void, null());
        if ctx.is_null() {
            return Err("El certificado ya no está en Windows (si es del DNIe o de una tarjeta, métela en el lector)".into());
        }
        // La búsqueda devuelve una referencia propia: el almacén se puede cerrar.
        key_from_context(ctx, hwnd)
    }
}

/// Toma posesión de `ctx` (se libera con la clave).
pub(crate) unsafe fn key_from_context(ctx: *const CERT_CONTEXT, hwnd: isize) -> Result<StoreKey, String> {
    let cert = std::slice::from_raw_parts((*ctx).pbCertEncoded, (*ctx).cbCertEncoded as usize).to_vec();
    let ec = cert_parts(&cert).map(|p| p.key_oid.ends_with(&[0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01])).unwrap_or(false);
    let mut key = StoreKey { ctx, cert, chain: Vec::new(), ec, hwnd };
    // Cadena hasta la raíz (sin el propio certificado), si Windows la conoce.
    let mut para: CERT_CHAIN_PARA = std::mem::zeroed();
    para.cbSize = std::mem::size_of::<CERT_CHAIN_PARA>() as u32;
    let mut chain: *mut CERT_CHAIN_CONTEXT = null_mut();
    if CertGetCertificateChain(null_mut(), ctx, null(), null_mut(), &para, 0, null(), &mut chain) != 0 && !chain.is_null() {
        if (*chain).cChain > 0 {
            let simple = &**(*chain).rgpChain;
            for i in 1..simple.cElement as usize {
                let el = &**simple.rgpElement.add(i);
                let c = &*el.pCertContext;
                key.chain.push(std::slice::from_raw_parts(c.pbCertEncoded, c.cbCertEncoded as usize).to_vec());
            }
        }
        CertFreeCertificateChain(chain);
    }
    Ok(key)
}

impl StoreKey {
    unsafe fn sign_ncrypt(&self, handle: usize, digest: &[u8; 32]) -> Result<Vec<u8>, String> {
        let pad = BCRYPT_PKCS1_PADDING_INFO { pszAlgId: BCRYPT_SHA256_ALGORITHM };
        let (info, flags) =
            if self.ec { (null(), 0) } else { (&pad as *const _ as *const c_void, NCRYPT_PAD_PKCS1_FLAG) };
        let mut len = 0u32;
        let hr = NCryptSignHash(handle, info, digest.as_ptr(), 32, null_mut(), 0, &mut len, flags);
        if hr != 0 {
            return Err(win_error("No se ha podido firmar", hr as u32));
        }
        let mut sig = vec![0u8; len as usize];
        let hr = NCryptSignHash(handle, info, digest.as_ptr(), 32, sig.as_mut_ptr(), len, &mut len, flags);
        if hr != 0 {
            return Err(win_error("No se ha podido firmar", hr as u32));
        }
        sig.truncate(len as usize);
        Ok(if self.ec { ecdsa_der(&sig) } else { sig })
    }

    /// CryptoAPI antigua (algunos proveedores de tarjeta y claves importadas hace años).
    unsafe fn sign_capi(&self, prov: usize, spec: u32, digest: &[u8; 32]) -> Result<Vec<u8>, String> {
        let mut hash = 0usize;
        let mut aes_prov = 0usize;
        if CryptCreateHash(prov, CALG_SHA_256, 0, 0, &mut hash) == 0 {
            // Proveedor RSA «completo» sin SHA-256: el mismo contenedor con el proveedor AES de Microsoft.
            let info = property(self.ctx, CERT_KEY_PROV_INFO_PROP_ID).ok_or("El certificado no tiene clave")?;
            let info = &*(info.as_ptr() as *const CRYPT_KEY_PROV_INFO);
            let ok = CryptAcquireContextW(
                &mut aes_prov,
                info.pwszContainerName,
                MS_ENH_RSA_AES_PROV_W,
                PROV_RSA_AES,
                info.dwFlags & CRYPT_MACHINE_KEYSET,
            ) != 0
                && CryptCreateHash(aes_prov, CALG_SHA_256, 0, 0, &mut hash) != 0;
            if !ok {
                let code = GetLastError();
                if aes_prov != 0 {
                    CryptReleaseContext(aes_prov, 0);
                }
                return Err(win_error("La clave del certificado no admite SHA-256", code));
            }
        }
        let result = (|| {
            if CryptSetHashParam(hash, HP_HASHVAL, digest.as_ptr(), 0) == 0 {
                return Err(win_error("No se ha podido firmar", GetLastError()));
            }
            let mut len = 0u32;
            if CryptSignHashW(hash, spec, null(), 0, null_mut(), &mut len) == 0 {
                return Err(win_error("No se ha podido firmar", GetLastError()));
            }
            let mut sig = vec![0u8; len as usize];
            if CryptSignHashW(hash, spec, null(), 0, sig.as_mut_ptr(), &mut len) == 0 {
                return Err(win_error("No se ha podido firmar", GetLastError()));
            }
            sig.truncate(len as usize);
            sig.reverse(); // CryptoAPI la da en little-endian
            Ok(sig)
        })();
        CryptDestroyHash(hash);
        if aes_prov != 0 {
            CryptReleaseContext(aes_prov, 0);
        }
        result
    }
}

impl Key for StoreKey {
    fn certificate(&self) -> &[u8] {
        &self.cert
    }

    fn chain(&self) -> &[Vec<u8>] {
        &self.chain
    }

    fn sign_digest(&self, digest: &[u8; 32]) -> Result<Vec<u8>, String> {
        unsafe {
            let mut handle = 0usize;
            let mut spec = 0u32;
            let mut free = 0;
            let mut flags = CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG;
            let hwnd = self.hwnd;
            let param = if hwnd != 0 {
                flags |= CRYPT_ACQUIRE_WINDOW_HANDLE_FLAG;
                &hwnd as *const isize as *const c_void
            } else {
                null()
            };
            if CryptAcquireCertificatePrivateKey(self.ctx, flags, param, &mut handle, &mut spec, &mut free) == 0 {
                return Err(win_error("No se ha podido usar la clave del certificado", GetLastError()));
            }
            let ncrypt = spec == CERT_NCRYPT_KEY_SPEC;
            let result = if ncrypt { self.sign_ncrypt(handle, digest) } else { self.sign_capi(handle, spec, digest) };
            if free != 0 {
                if ncrypt {
                    NCryptFreeObject(handle);
                } else {
                    CryptReleaseContext(handle, 0);
                }
            }
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_sign::{sign_pdf, Seal, SignOptions};
    use std::path::Path;

    /// Certificado autofirmado en memoria con una clave temporal (se borra al terminar).
    struct TestCert {
        ctx: *const CERT_CONTEXT,
        cleanup: Box<dyn Fn()>,
    }

    impl Drop for TestCert {
        fn drop(&mut self) {
            (self.cleanup)();
        }
    }

    unsafe fn self_signed(prov_or_key: usize, info: &CRYPT_KEY_PROV_INFO, sig_oid: &[u8]) -> *const CERT_CONTEXT {
        let subject = wide("CN=Prueba pdfiiuum Ñandú, O=pdfiiuum");
        let mut size = 0u32;
        assert!(CertStrToNameW(ENCODING, subject.as_ptr(), CERT_X500_NAME_STR, null(), null_mut(), &mut size, null_mut()) != 0);
        let mut name = vec![0u8; size as usize];
        assert!(CertStrToNameW(ENCODING, subject.as_ptr(), CERT_X500_NAME_STR, null(), name.as_mut_ptr(), &mut size, null_mut()) != 0);
        let blob = CRYPT_INTEGER_BLOB { cbData: size, pbData: name.as_mut_ptr() };
        let alg = CRYPT_ALGORITHM_IDENTIFIER { pszObjId: sig_oid.as_ptr() as *mut u8, Parameters: std::mem::zeroed() };
        let ctx = CertCreateSelfSignCertificate(prov_or_key, &blob, 0, info, &alg, null(), null(), null());
        assert!(!ctx.is_null(), "CertCreateSelfSignCertificate: 0x{:08X}", GetLastError());
        ctx
    }

    /// Clave CNG (Microsoft Software Key Storage Provider), RSA o ECDSA P-256.
    fn cng_cert(alg: &str) -> TestCert {
        unsafe {
            let mut prov = 0usize;
            assert_eq!(NCryptOpenStorageProvider(&mut prov, MS_KEY_STORAGE_PROVIDER, 0), 0);
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let container = wide(&format!("pdfiiuum-prueba-{}-{}-{}", alg, std::process::id(), n));
            let mut key = 0usize;
            let alg_w = wide(alg);
            assert_eq!(NCryptCreatePersistedKey(prov, &mut key, alg_w.as_ptr(), container.as_ptr(), 0, NCRYPT_OVERWRITE_KEY_FLAG), 0);
            if alg == "RSA" {
                let bits = 2048u32.to_le_bytes();
                assert_eq!(NCryptSetProperty(key, NCRYPT_LENGTH_PROPERTY, bits.as_ptr(), 4, 0), 0);
            }
            assert_eq!(NCryptFinalizeKey(key, 0), 0);
            let mut container_buf = container.clone();
            let mut prov_name = wide("Microsoft Software Key Storage Provider");
            let info = CRYPT_KEY_PROV_INFO {
                pwszContainerName: container_buf.as_mut_ptr(),
                pwszProvName: prov_name.as_mut_ptr(),
                dwProvType: 0,
                dwFlags: 0,
                cProvParam: 0,
                rgProvParam: null_mut(),
                dwKeySpec: 0,
            };
            let sig_oid: &[u8] = if alg == "RSA" { b"1.2.840.113549.1.1.11\0" } else { b"1.2.840.10045.4.3.2\0" };
            let ctx = self_signed(key, &info, sig_oid);
            TestCert {
                ctx,
                cleanup: Box::new(move || {
                    NCryptDeleteKey(key, 0);
                    NCryptFreeObject(prov);
                }),
            }
        }
    }

    /// Clave en el proveedor RSA antiguo de CryptoAPI (sin SHA-256 propio), como las importadas hace años.
    fn capi_cert() -> TestCert {
        unsafe {
            let container = wide(&format!("pdfiiuum-prueba-capi-{}", std::process::id()));
            let mut prov = 0usize;
            let mut old = 0usize;
            CryptAcquireContextW(&mut old, container.as_ptr(), MS_ENHANCED_PROV_W, PROV_RSA_FULL, CRYPT_DELETEKEYSET);
            assert!(CryptAcquireContextW(&mut prov, container.as_ptr(), MS_ENHANCED_PROV_W, PROV_RSA_FULL, CRYPT_NEWKEYSET) != 0);
            let mut key = 0usize;
            assert!(CryptGenKey(prov, AT_SIGNATURE, 2048 << 16, &mut key) != 0);
            CryptDestroyKey(key);
            let mut container_buf = container.clone();
            let mut prov_name = wide("Microsoft Enhanced Cryptographic Provider v1.0");
            let info = CRYPT_KEY_PROV_INFO {
                pwszContainerName: container_buf.as_mut_ptr(),
                pwszProvName: prov_name.as_mut_ptr(),
                dwProvType: PROV_RSA_FULL,
                dwFlags: 0,
                cProvParam: 0,
                rgProvParam: null_mut(),
                dwKeySpec: AT_SIGNATURE,
            };
            let ctx = self_signed(prov, &info, b"1.2.840.113549.1.1.5\0");
            CryptReleaseContext(prov, 0);
            TestCert {
                ctx,
                cleanup: Box::new(move || {
                    let mut gone = 0usize;
                    CryptAcquireContextW(&mut gone, container.as_ptr(), MS_ENHANCED_PROV_W, PROV_RSA_FULL, CRYPT_DELETEKEYSET);
                }),
            }
        }
    }

    /// Comprueba con Windows la firma CMS sobre los dos tramos de /ByteRange.
    fn verify(signed: &[u8]) -> bool {
        let text = String::from_utf8_lossy(signed);
        let at = text.rfind("/ByteRange").unwrap();
        let open = at + text[at..].find('[').unwrap();
        let close = open + text[open..].find(']').unwrap();
        let r: Vec<usize> = text[open + 1..close].split_whitespace().map(|n| n.parse().unwrap()).collect();
        assert_eq!(r[0], 0);
        assert_eq!(r[2] + r[3], signed.len());
        let hex = &signed[r[1] + 1..r[2] - 1];
        let mut der: Vec<u8> = hex.chunks(2).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 16).unwrap()).collect();
        // El CMS ocupa lo que dice su cabecera; el resto son ceros de relleno.
        let len = match der[1] {
            n if n < 0x80 => 2 + n as usize,
            0x82 => 4 + ((der[2] as usize) << 8 | der[3] as usize),
            0x83 => 5 + ((der[2] as usize) << 16 | (der[3] as usize) << 8 | der[4] as usize),
            _ => panic!("longitud"),
        };
        der.truncate(len);
        unsafe {
            let para = CRYPT_VERIFY_MESSAGE_PARA {
                cbSize: std::mem::size_of::<CRYPT_VERIFY_MESSAGE_PARA>() as u32,
                dwMsgAndCertEncodingType: ENCODING,
                hCryptProv: 0,
                pfnGetSignerCertificate: None,
                pvGetArg: null_mut(),
            };
            let parts = [signed.as_ptr(), signed[r[2]..].as_ptr()];
            let lens = [r[1] as u32, r[3] as u32];
            CryptVerifyDetachedMessageSignature(&para, 0, der.as_ptr(), der.len() as u32, 2, parts.as_ptr(), lens.as_ptr(), null_mut()) != 0
        }
    }

    fn sample() -> Vec<u8> {
        crate::pdf_pages::tests_sample()
    }

    fn signature_count(pdf: &[u8]) -> i32 {
        let dll = Path::new(env!("CARGO_MANIFEST_DIR")).join("lib/pdfium.dll");
        let guard = crate::pdf_engine::engine(&dll).unwrap().lock().unwrap();
        unsafe {
            let doc = crate::pdf_engine::load_document(&guard, pdf).unwrap();
            let n = guard.FPDF_GetSignatureCount(doc);
            guard.FPDF_CloseDocument(doc);
            n
        }
    }

    fn opts(seal: bool) -> SignOptions {
        SignOptions {
            date: "D:20261109120000+01'00'".into(),
            seal: seal.then(|| Seal { page: 0, rect: [50.0, 50.0, 260.0, 110.0], date_text: "09/11/2026 12:00:00".into() }),
        }
    }

    #[test]
    fn signs_with_cng_rsa_and_ecdsa_keys() {
        for alg in ["RSA", "ECDSA_P256"] {
            let cert = cng_cert(alg);
            let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
            assert_eq!(key.ec, alg != "RSA");
            let pdf = sample();
            let signed = sign_pdf(&pdf, &key, &opts(true)).unwrap();
            assert!(signed.starts_with(&pdf));
            assert!(verify(&signed), "{alg}: la firma no verifica");
            assert_eq!(signature_count(&signed), 1);
            // Una segunda firma va detrás de la primera y las dos siguen valiendo.
            let twice = sign_pdf(&signed, &key, &opts(false)).unwrap();
            assert!(twice.starts_with(&signed));
            assert!(verify(&twice));
            assert_eq!(signature_count(&twice), 2);
            assert!(String::from_utf8_lossy(&twice).contains("(Firma2)"));
        }
    }

    #[test]
    fn signs_with_old_cryptoapi_keys() {
        let cert = capi_cert();
        let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
        let signed = sign_pdf(&sample(), &key, &opts(false)).unwrap();
        assert!(verify(&signed));
    }

    #[test]
    fn reads_the_signer_name() {
        let cert = cng_cert("ECDSA_P256");
        let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
        assert_eq!(crate::pdf_sign::subject_name(&key.cert).as_deref(), Some("Prueba pdfiiuum Ñandú"));
    }

    #[test]
    fn rejects_encrypted_pdfs() {
        let cert = cng_cert("ECDSA_P256");
        let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
        let encrypted = crate::pdf_engine::tests_encrypt(&sample(), "clave");
        assert_eq!(sign_pdf(&encrypted, &key, &opts(false)).unwrap_err(), crate::pdf_sign::ENCRYPTED_ERROR);
    }

    #[test]
    fn hides_windows_own_certificates() {
        assert!(is_windows_internal("e55fed00-af72-464d-b769-a710736b10a2"));
        assert!(is_windows_internal("MS-Organization-Access"));
        assert!(!is_windows_internal("AC FNMT Usuarios"));
        assert!(!is_windows_internal("AC DNIE 004"));
    }

    /// Firma y comprueba: lo anterior intacto, la firma válida y un campo de firma más para PDFium.
    fn sign_and_check(pdf: &[u8], seal: bool) -> Vec<u8> {
        let cert = cng_cert("ECDSA_P256");
        let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
        let before = signature_count(pdf);
        let signed = sign_pdf(pdf, &key, &opts(seal)).unwrap();
        assert!(signed.starts_with(pdf));
        assert!(verify(&signed));
        assert_eq!(signature_count(&signed), before + 1);
        signed
    }

    #[test]
    fn signs_pdfs_with_compressed_objects_and_xref_streams() {
        let mut doc = lopdf::Document::load_mem(&sample()).unwrap();
        let mut modern = Vec::new();
        doc.save_modern(&mut modern).unwrap();
        assert!(!String::from_utf8_lossy(&modern).contains("
trailer"));
        let signed = sign_and_check(&modern, true);
        // La actualización también usa un flujo de referencias, enlazado con el anterior.
        let tail = String::from_utf8_lossy(&signed[modern.len()..]).into_owned();
        assert!(tail.contains("/Type/XRef") && tail.contains("/Prev"), "{tail}");
    }

    #[test]
    fn signs_when_the_form_and_annotations_are_separate_objects() {
        let mut out = b"%PDF-1.7
".to_vec();
        let objects = [
            "<</Type/Catalog/Pages 2 0 R/AcroForm 4 0 R>>",
            "<</Type/Pages/Kids[3 0 R]/Count 1>>",
            "<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Annots 5 0 R>>",
            "<</Fields 6 0 R/DA(/Helv 0 Tf 0 g)>>",
            "[7 0 R]",
            "[7 0 R]",
            "<</Type/Annot/Subtype/Widget/FT/Tx/T(Firma1)/V(hola)/Rect[10 10 100 30]/P 3 0 R>>",
        ];
        let mut offsets = Vec::new();
        for (i, o) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend(format!("{} 0 obj
{o}
endobj
", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend(format!("xref
0 {}
0000000000 65535 f 
", objects.len() + 1).as_bytes());
        for off in offsets {
            out.extend(format!("{off:010} 00000 n 
").as_bytes());
        }
        out.extend(format!("trailer
<</Size {}/Root 1 0 R>>
startxref
{xref}
%%EOF
", objects.len() + 1).as_bytes());
        let signed = sign_and_check(&out, false);
        let doc = lopdf::Document::load_mem(&signed).unwrap();
        // Los arrays aparte crecen; el campo nuevo no repite el nombre del que ya había.
        assert_eq!(doc.get_object((5, 0)).unwrap().as_array().unwrap().len(), 2);
        assert_eq!(doc.get_object((6, 0)).unwrap().as_array().unwrap().len(), 2);
        let af = doc.get_dictionary((4, 0)).unwrap();
        assert_eq!(af.get(b"SigFlags").unwrap().as_i64().unwrap(), 3);
        assert!(af.get(b"DA").is_ok());
        let new_field = doc.get_object((6, 0)).unwrap().as_array().unwrap()[1].as_reference().unwrap();
        assert_eq!(doc.get_dictionary(new_field).unwrap().get(b"T").unwrap().as_str().unwrap(), b"Firma2");
    }

    /// PDFIIUUM_SIGN_OUT=carpeta cargo test writes_signed_samples: deja PDF firmados para revisarlos.
    #[test]
    fn writes_signed_samples() {
        let Ok(dir) = std::env::var("PDFIIUUM_SIGN_OUT") else { return };
        let dir = Path::new(&dir);
        let cert = cng_cert("RSA");
        let key = unsafe { key_from_context(CertDuplicateCertificateContext(cert.ctx), 0) }.unwrap();
        std::fs::write(dir.join("cert.der"), &key.cert).unwrap();
        let pdf = sample();
        std::fs::write(dir.join("visible.pdf"), sign_pdf(&pdf, &key, &opts(true)).unwrap()).unwrap();
        std::fs::write(dir.join("invisible.pdf"), sign_pdf(&pdf, &key, &opts(false)).unwrap()).unwrap();
        // Página girada 90°: el sello tiene que verse derecho.
        let mut doc = lopdf::Document::load_mem(&pdf).unwrap();
        let page = *doc.get_pages().get(&1).unwrap();
        doc.get_dictionary_mut(page).unwrap().set("Rotate", lopdf::Object::Integer(90));
        let mut rotated = Vec::new();
        doc.save_to(&mut rotated).unwrap();
        let o = SignOptions {
            date: "D:20261109120000+01'00'".into(),
            seal: Some(Seal { page: 0, rect: [50.0, 50.0, 110.0, 260.0], date_text: "09/11/2026 12:00:00".into() }),
        };
        std::fs::write(dir.join("girada.pdf"), sign_pdf(&rotated, &key, &o).unwrap()).unwrap();
    }

    /// Solo lee: lista los certificados del usuario (cargo test -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn lists_the_user_certificates() {
        for c in list().unwrap() {
            println!("emisor: {} · firma={} tarjeta={} · caduca={}", c.issuer, c.signing, c.card, c.valid_to);
        }
    }
}
