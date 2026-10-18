import { ArrowRight, Bot, Folder, MessageSquarePlus, Search, Shapes } from "lucide-react";
import { useId, useState, type FormEvent, type JSX } from "react";
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
  const hintId = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const url = resolveBrowserInput(address);
    if (!url) { setError("Enter a web address or search term."); return; }
    setError(null);
    onBrowse(url);
  };
  const tools: Array<{ id: ReviewNewTabTool; label: string; hint: string; icon: JSX.Element }> = [
    { id: "changes", label: "Changes", hint: "Review the diff", icon: <ChangesIcon size={16} /> },
    { id: "files", label: "Files", hint: "Browse the checkout", icon: <Folder size={16} /> },
    ...(hasTerminal ? [{ id: "terminal" as const, label: "Terminal", hint: "Run commands in this checkout", icon: <TerminalIcon size={16} /> }] : []),
    ...(hasSideChat ? [{ id: "side-chat" as const, label: "Side chat", hint: "Ask a separate question", icon: <MessageSquarePlus size={16} /> }] : []),
    ...(hasAgents ? [{ id: "agents" as const, label: "Agents", hint: "Follow subagent work", icon: <Bot size={16} /> }] : []),
    ...(hasBrowser && artifactsEnabled ? [{ id: "artifacts" as const, label: "Claude artifacts", hint: "Browse your claude.ai artifacts", icon: <Shapes size={16} /> }] : [])
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
      <div className="review-new-tool-grid">
        {tools.map((tool) => <button key={tool.id} type="button" aria-label={tool.label}
          aria-describedby={`${hintId}-${tool.id}`} onClick={() => onOpen(tool.id)}>
          <span className="review-new-tool-icon" aria-hidden="true">{tool.icon}</span>
          <span className="review-new-tool-text">
            <span className="review-new-tool-label">{tool.label}</span>
            <span className="review-new-tool-hint" id={`${hintId}-${tool.id}`}>{tool.hint}</span>
          </span>
          <ArrowRight className="review-new-tool-arrow" size={14} aria-hidden="true" />
        </button>)}
      </div>
    </div>
  </div>;
}
