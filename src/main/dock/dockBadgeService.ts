export interface DockBadgeDeps {
  setBadge: (text: string) => void;
  countAttention: () => { total: number };
}

export class DockBadgeService {
  private lastText = "";

  constructor(private readonly deps: DockBadgeDeps) {}

  update(): void {
    const { total } = this.deps.countAttention();
    const text = total > 0 ? this.format(total) : "";
    if (text === this.lastText) return;
    this.lastText = text;
    this.deps.setBadge(text);
  }

  private format(count: number): string {
    if (count > 99) return "99+";
    return String(count);
  }
}
