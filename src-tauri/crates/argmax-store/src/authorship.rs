// Who wrote a prompt. A chat reference in a prompt is a read grant only when a
// person wrote it, and "a person wrote it" is a positive mark, never the
// absence of other marks: every path that writes a `user.message` and forgot to
// say who wrote it must grant nothing. The mark lives in a column rather than
// the payload JSON, which is rewritten, copied, and built from provider and
// sync data.

/// Proof that the text came from the person's own composer over IPC (the
/// desktop webview or the paired remote device). Rust visibility cannot reach
/// across crates to one module of the app, so the rule that only `crate::ipc`
/// mints one is a source check: `check:rust-boundaries` rule
/// `person-attestation-outside-ipc` and the test
/// `ipc::tests::person_attestation_is_minted_only_by_the_person_handlers`.
pub struct PersonAttestation(());

impl PersonAttestation {
    #[doc(hidden)]
    pub fn minted_by_ipc() -> Self {
        Self(())
    }
}

/// `person` only for text that arrived as fresh input on a person IPC call.
/// The field is private, so nothing outside this module builds a person author
/// except through a [`PersonAttestation`], which only `crate::ipc` mints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PromptAuthor {
    person: bool,
}

impl PromptAuthor {
    /// Everything but a person call: agents, schedules, goals, moves, notices,
    /// imports, legacy rows.
    pub const fn unattested() -> Self {
        Self { person: false }
    }

    pub fn person(_attestation: PersonAttestation) -> Self {
        Self { person: true }
    }

    /// The stored value; NULL and anything unknown read as unattested.
    pub(super) fn from_column(value: Option<&str>) -> Self {
        Self {
            person: value == Some(PERSON),
        }
    }

    pub fn as_column(self) -> Option<&'static str> {
        self.person.then_some(PERSON)
    }

    pub fn is_person(self) -> bool {
        self.person
    }
}

const PERSON: &str = "person";
