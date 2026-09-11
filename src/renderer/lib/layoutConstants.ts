/** Smallest desktop composer width that keeps its controls comfortable. */
export const COMPOSER_MIN_WIDTH_PX = 400;

/** Every desktop chat pane owns a composer, so the pane and composer floors
 *  stay aligned instead of letting one surface become narrower than the
 *  other. */
export const SESSION_CELL_MIN_WIDTH_PX = COMPOSER_MIN_WIDTH_PX;
export const CHAT_PANE_MIN_WIDTH_PX = COMPOSER_MIN_WIDTH_PX;
