import { ArrowLeft, Search } from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { SETTINGS_GROUPS, type SettingsGroupId } from "./settingsMeta.js";
import { searchPaletteItems } from "../../lib/paletteSearch.js";

/** One searchable row: a section, or a setting inside it that lands there. */
type SettingsHit = {
  group: SettingsGroupId;
  sectionId: string;
  label: string;
  /** Where the hit lives: the group for a section, "Group · Section" for a setting. */
  location: string;
};

const ALL_HITS: ReadonlyArray<SettingsHit> = SETTINGS_GROUPS.flatMap((group) =>
  group.sections.flatMap((section) => [
    { group: group.id, sectionId: section.id, label: section.label, location: group.label },
    ...(section.settings ?? []).map((setting) => ({
      group: group.id,
      sectionId: section.id,
      label: setting,
      location: `${group.label} · ${section.label}`
    }))
  ])
);

/**
 * Settings takes over the sidebar column, so this rail replaces the app
 * sidebar for as long as the page is open: a way back, a filter, and the group
 * list. The filter searches section and row labels from the same registry the
 * command palette lists, and every hit lands on its section.
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
    const commands = ALL_HITS.map((hit, index) => ({
      id: String(index),
      label: hit.label,
      subtitle: hit.location,
      group: "Settings" as const,
      run: () => undefined
    }));
    return searchPaletteItems(commands, trimmed).map(({ item }) => ALL_HITS[Number(item.id)]);
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

      <div className="settings-rail-scroll scroll-fade">
        <div className="settings-rail-body">
          {hits ? (
            hits.length === 0 ? (
              <p className="settings-rail-empty">No settings match “{query.trim()}”.</p>
            ) : (
              <ul className="settings-rail-hits" aria-label="Matching settings">
                {hits.map((hit) => (
                  <li key={`${hit.sectionId}:${hit.label}`}>
                    <button
                      type="button"
                      className="settings-rail-hit"
                      onClick={() => {
                        setQuery("");
                        onOpenSection(hit.group, hit.sectionId);
                      }}
                    >
                      <span className="settings-rail-hit-label">{hit.label}</span>
                      <span className="settings-rail-hit-group">{hit.location}</span>
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
        </div>
      </div>
    </aside>
  );
}
