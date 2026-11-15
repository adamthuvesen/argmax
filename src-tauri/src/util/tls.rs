/// reqwest is built with `rustls-no-provider`, so building a client panics
/// until a rustls crypto provider is installed. `run()` installs `ring` at boot;
/// every client builder calls this too, so tests and early callers are covered.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
