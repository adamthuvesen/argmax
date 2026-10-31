//! Model facts generated from `src/shared/providerModels.ts`, and [`ModelId`],
//! the only way a stored model id reaches a launch or a routing decision.

use std::fmt;
use std::ops::Deref;

use argmax_contracts::validation::{ProviderId, ReasoningEffort};

/// One row of `PROVIDER_MODELS` or `STORED_ONLY_MODELS`. A stored-only row has
/// no label, because the picker does not offer it.
#[derive(Debug, PartialEq, Eq)]
pub struct CatalogueModel {
    pub provider: ProviderId,
    pub model_id: &'static str,
    pub label: Option<&'static str>,
    /// Low to high. Empty for a model with no effort control.
    pub efforts: &'static [ReasoningEffort],
    pub supports_fast_mode: bool,
    pub fast_mode_model_id: Option<&'static str>,
    pub context_window: Option<u64>,
}

/// The model a provider launches on when nothing more specific names one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDefaults {
    pub model_label: &'static str,
    pub model_id: &'static str,
    pub reasoning_effort: Option<&'static str>,
}

include!("model_catalogue.generated.rs");

pub fn catalogue_model(provider: ProviderId, model_id: &str) -> Option<&'static CatalogueModel> {
    CATALOGUE_MODELS
        .iter()
        .find(|model| model.provider == provider && model.model_id == model_id)
}

/// The effort a model runs at: the requested level, else the strongest offered
/// level below it, else the weakest offered. `None` when `offered` is empty.
pub fn clamp_effort(
    effort: ReasoningEffort,
    offered: &[ReasoningEffort],
) -> Option<ReasoningEffort> {
    offered
        .iter()
        .copied()
        .filter(|candidate| (*candidate as u8) <= effort as u8)
        .max_by_key(|candidate| *candidate as u8)
        .or_else(|| offered.iter().copied().min_by_key(|level| *level as u8))
}

/// A model id that has been through the successor map, so a stored id that
/// names a retired model reads as the model that replaced it. The stored row
/// keeps its id: only the model the CLI runs and the router reasons about move.
/// `resolveModelId` in `src/shared/providerModels.ts` is the renderer's half.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelId(String);

impl ModelId {
    pub fn resolve(provider: ProviderId, stored: &str) -> Self {
        let key = super::pricing::normalize_model_id(stored);
        let successor = SUCCESSOR_MODEL_IDS
            .iter()
            .find(|(owner, retired, _)| *owner == provider && *retired == key)
            .map(|(_, _, successor)| *successor);
        Self(successor.unwrap_or(stored).to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Deref for ModelId {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ModelId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl PartialEq<str> for ModelId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<&str> for ModelId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_retired_id_resolves_to_its_successor() {
        for (provider, retired, successor) in SUCCESSOR_MODEL_IDS {
            let resolved = ModelId::resolve(*provider, retired);
            assert_eq!(resolved, *successor, "{retired} did not resolve");
            assert!(
                catalogue_model(*provider, resolved.as_str())
                    .is_some_and(|model| model.label.is_some()),
                "{retired} resolves to {successor}, which the picker does not offer"
            );
        }
    }

    #[test]
    fn a_dated_retired_id_resolves_and_a_current_id_is_untouched() {
        assert_eq!(
            ModelId::resolve(ProviderId::Claude, "claude-haiku-4-5-20251001"),
            "claude-haiku-5-5"
        );
        assert_eq!(
            ModelId::resolve(ProviderId::Claude, "claude-opus-5-5"),
            "claude-opus-5-5"
        );
        assert_eq!(
            ModelId::resolve(ProviderId::Claude, "not-a-model"),
            "not-a-model"
        );
    }

    #[test]
    fn a_successor_applies_only_to_its_own_provider() {
        assert_eq!(
            ModelId::resolve(ProviderId::Cursor, "gpt-6-sol"),
            "gpt-6-sol"
        );
    }

    #[test]
    fn clamping_never_promotes_unless_nothing_is_lower() {
        use ReasoningEffort::{High, Low, Max, Medium, Ultra};
        assert_eq!(clamp_effort(Medium, &[Low, High, Max]), Some(Low));
        assert_eq!(clamp_effort(Ultra, &[Low, High, Max]), Some(Max));
        assert_eq!(clamp_effort(Low, &[High, Max]), Some(High));
        assert_eq!(clamp_effort(Low, &[]), None);
    }
}
