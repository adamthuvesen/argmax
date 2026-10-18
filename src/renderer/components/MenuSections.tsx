import { Fragment, type ReactNode } from "react";

/** Rows of a picker menu split into groups, with a divider between groups.
 *  Most action rows are conditional, so a group whose rows all render null is
 *  dropped instead of leaving two dividers back to back. */
export function MenuSections({ sections }: { sections: ReactNode[][] }) {
  const present = sections
    .map((section) => section.filter((row) => row !== null && row !== undefined && row !== false))
    .filter((rows) => rows.length > 0);
  return (
    <>
      {present.map((rows, sectionIndex) => (
        <Fragment key={sectionIndex}>
          {sectionIndex > 0 ? <li className="project-picker-divider" role="separator" /> : null}
          {rows.map((row, rowIndex) => (
            <Fragment key={rowIndex}>{row}</Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}
