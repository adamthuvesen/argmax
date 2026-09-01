import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { SETTINGS_GROUPS, type SettingsGroupId } from "./settingsMeta.js";

type SectionHit = { group: SettingsGroupId; groupLabel: string; sectionId: string; sectionLabel: string };

const ALL_SECTIONS: ReadonlyArray<SectionHit> = SETTINGS_GROUPS.flatMap((group) =>
  group.sections.map((section) => ({
    group: group.id,
    groupLabel: group.label,
    sectionId: section.id,
    sectionLabel: section.label
  }))
);

/**
 * Settings takes over the sidebar column, so this rail replaces the app
 * sidebar for as long as the page is open: a way back, a filter, and the group
 * list. The filter searches section labels — the same registry the command
 * palette lists — so a hit always has somewhere to land.
 */
export function SettingsRail({
  active,
  onChange,
  onOpenSection,
  onBack
}: {
  active: SettingsGroupId;
  onChange: (group: SettingsGroupId) => void;
  onOpenSection: (group: SettingsGroupId, sectionId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const trimmed = query.trim().toLowerCase();
  const hits = useMemo(() => {
    if (trimmed === "") return null;
    return ALL_SECTIONS.filter(
      (hit) =>
        hit.sectionLabel.toLowerCase().includes(trimmed) || hit.groupLabel.toLowerCase().includes(trimmed)
    );
  }, [trimmed]);

  return (
    <aside className="settings-rail" aria-label="Settings groups">
      <div className="window-controls" data-window-drag />
      <button type="button" className="settings-rail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back</span>
      </button>

      <div className="settings-rail-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {hits ? (
        hits.length === 0 ? (
          <p className="settings-rail-empty">No settings match “{query.trim()}”.</p>
        ) : (
          <ul className="settings-rail-hits" aria-label="Matching settings">
            {hits.map((hit) => (
              <li key={`${hit.group}:${hit.sectionId}`}>
                <button
                  type="button"
                  className="settings-rail-hit"
                  onClick={() => {
                    setQuery("");
                    onOpenSection(hit.group, hit.sectionId);
                  }}
                >
                  <span className="settings-rail-hit-label">{hit.sectionLabel}</span>
                  <span className="settings-rail-hit-group">{hit.groupLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <ol className="settings-rail-list">
          {SETTINGS_GROUPS.map((group) => (
            <li key={group.id} data-divider-before={group.dividerBefore ? "true" : undefined}>
              <button
                type="button"
                className="settings-rail-link"
                aria-pressed={group.id === active}
                onClick={() => onChange(group.id)}
              >
                {group.label}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
