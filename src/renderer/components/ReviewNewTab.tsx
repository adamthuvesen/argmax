import { ArrowRight, Bot, Folder, Globe, MessageSquarePlus, Search, Shapes } from "lucide-react";
import { useState, type FormEvent, type JSX } from "react";
import { resolveBrowserInput } from "../lib/browserPanel.js";
import { ChangesIcon, TerminalIcon } from "./ReviewModeIcons.js";
import "../styles/review-new-tab.css";

export type ReviewNewTabTool = "changes" | "files" | "agents" | "terminal" | "side-chat" | "artifacts";

export function ReviewNewTab({ onOpen, onBrowse, hasAgents, hasTerminal, hasSideChat, hasBrowser, artifactsEnabled }: {
  onOpen: (tool: ReviewNewTabTool) => void;
  onBrowse: (url: string) => void;
  hasAgents: boolean;
  hasTerminal: boolean;
  hasSideChat: boolean;
  hasBrowser: boolean;
  artifactsEnabled: boolean;
}): JSX.Element {
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const url = resolveBrowserInput(address);
    if (!url) { setError("Enter a web address or search term."); return; }
    setError(null);
    onBrowse(url);
  };
  const tools: Array<{ id: ReviewNewTabTool; label: string; icon: JSX.Element }> = [
    { id: "changes", label: "Changes", icon: <ChangesIcon /> },
    { id: "files", label: "Files", icon: <Folder size={18} /> },
    ...(hasTerminal ? [{ id: "terminal" as const, label: "Terminal", icon: <TerminalIcon size={18} /> }] : []),
    ...(hasSideChat ? [{ id: "side-chat" as const, label: "Side chat", icon: <MessageSquarePlus size={18} /> }] : []),
    ...(hasAgents ? [{ id: "agents" as const, label: "Agents", icon: <Bot size={18} /> }] : []),
    ...(hasBrowser && artifactsEnabled ? [{ id: "artifacts" as const, label: "Claude artifacts", icon: <Shapes size={18} /> }] : [])
  ];
  return <div className="review-new-tab">
    {hasBrowser ? <form className="review-new-address" onSubmit={submit}>
      <Search size={16} aria-hidden="true" />
      <input aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={address}
        onChange={(event) => { setAddress(event.target.value); setError(null); }} spellCheck={false} autoCapitalize="off" autoComplete="off" />
      <button type="submit" aria-label="Open address" title="Open address" disabled={!address.trim()}><ArrowRight size={16} /></button>
    </form> : null}
    {error ? <p className="review-error" role="alert">{error}</p> : null}
    <div className="review-new-tools">
      <h2>Tools</h2>
      <div className="review-new-tool-grid">
        {tools.map((tool) => <button key={tool.id} type="button" onClick={() => onOpen(tool.id)}>
          <span aria-hidden="true">{tool.icon}</span><span>{tool.label}</span><ArrowRight size={14} aria-hidden="true" />
        </button>)}
      </div>
      {hasBrowser ? <p className="review-new-hint"><Globe size={14} aria-hidden="true" />Open a page alongside your work.</p> : null}
    </div>
  </div>;
}
