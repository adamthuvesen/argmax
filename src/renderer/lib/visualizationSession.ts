import { createContext } from "react";

/** The owning chat, including inside an independently mounted multitask pane. */
export const VisualizationSessionContext = createContext<string | null>(null);
