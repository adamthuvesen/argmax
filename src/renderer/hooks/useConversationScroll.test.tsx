import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationScroll, type ConversationScroll } from "./useConversationScroll.js";

type Geometry = {
  viewportHeight: number;
  naturalHeight: number;
  top: number;
  promptTop: number;
  blockTop: number;
  turnTop: number;
};

type HarnessProps = {
  sessionId?: string;
  resetKey?: string | null;
  enabled?: boolean;
  items: readonly string[];
};

let controller: ConversationScroll;

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  fire(): void {
    this.callback([], this);
  }
}

function flushResize(): void {
  ResizeObserverMock.instances[0]?.fire();
  vi.advanceTimersToNextFrame();
}

function Harness({
  sessionId = "session-a",
  resetKey = "prompt-a",
  enabled = true,
  items
}: HarnessProps): ReactElement {
  controller = useConversationScroll({ sessionId, resetKey, enabled, items });
  return (
    <div aria-label="Scroll viewport" ref={controller.scrollRef} tabIndex={0}>
      <div
        aria-label="Conversation content"
        ref={controller.contentRef}
        style={{ boxSizing: "border-box", paddingTop: 20 }}
      >
        <section aria-label="Conversation turn">
          <div data-turn-anchor="true">Latest prompt</div>
          <p>Reading block</p>
          <div
            aria-label="Nested scroll area"
            style={{ overflowY: "auto" }}
          >
            Nested content
          </div>
          {items.map((item) => <span key={item}>{item}</span>)}
        </section>
      </div>
    </div>
  );
}

function rect(top: number, height: number, width = 800): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  };
}

function installGeometry(geometry: Geometry): {
  scroll: HTMLDivElement;
  content: HTMLDivElement;
  block: HTMLElement;
  turn: HTMLElement;
  nested: HTMLElement;
} {
  const scroll = screen.getByLabelText<HTMLDivElement>("Scroll viewport");
  const content = screen.getByLabelText<HTMLDivElement>("Conversation content");
  const turn = screen.getByLabelText("Conversation turn");
  const prompt = screen.getByText("Latest prompt");
  const block = screen.getByText("Reading block");
  const nested = screen.getByLabelText("Nested scroll area");
  const effectiveHeight = (): number =>
    Math.max(geometry.naturalHeight, Number.parseFloat(content.style.minHeight) || 0);

  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, get: () => geometry.viewportHeight },
    clientWidth: { configurable: true, get: () => 800 },
    scrollHeight: { configurable: true, get: effectiveHeight },
    scrollTop: {
      configurable: true,
      get: () => geometry.top,
      set: (value: number) => {
        geometry.top = Math.max(0, Math.min(value, effectiveHeight() - geometry.viewportHeight));
      }
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(0, geometry.viewportHeight)
    }
  });
  Object.defineProperties(content, {
    offsetHeight: { configurable: true, get: effectiveHeight },
    scrollHeight: { configurable: true, get: effectiveHeight },
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(-geometry.top, effectiveHeight())
    }
  });
  Object.defineProperty(turn, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(geometry.turnTop - geometry.top, geometry.naturalHeight - geometry.turnTop)
  });
  Object.defineProperty(prompt, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(geometry.promptTop - geometry.top, 60)
  });
  Object.defineProperty(block, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(geometry.blockTop - geometry.top, 120)
  });
  Object.defineProperties(nested, {
    clientHeight: { configurable: true, get: () => 100 },
    scrollHeight: { configurable: true, get: () => 300 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(geometry.blockTop - geometry.top, 100)
    }
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => block)
  });
  return { scroll, content, block, turn, nested };
}

function wheel(target: Element, deltaY: number): void {
  target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY }));
}

function touch(target: Element, type: string, clientY: number): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : [{ clientY }]
  });
  target.dispatchEvent(event);
}

describe("useConversationScroll", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sizes the content so following places the latest prompt below the top padding", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 900,
      top: 0,
      promptTop: 600,
      blockTop: 650,
      turnTop: 0
    };
    const { content } = installGeometry(geometry);

    act(() => view.rerender(<Harness {...props} />));

    expect(content.style.minHeight).toBe("1080px");
    expect(geometry.top).toBe(580);
  });

  it("does not swallow an upward movement when a stream commit beats the scroll event", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1080,
      top: 0,
      promptTop: 600,
      blockTop: 650,
      turnTop: 0
    };
    installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    expect(geometry.top).toBe(580);

    geometry.top = 568;
    geometry.naturalHeight = 1400;
    act(() => view.rerender(<Harness {...props} items={["one", "two"]} />));

    expect(geometry.top).toBe(568);
    expect(controller.showScrollToBottom).toBe(true);
    expect(controller.newBelowCount).toBe(1);
  });

  it.each([
    ["commit", 12], ["observer", 12], ["scroll", 12],
    ["commit", 0.5], ["observer", 0.5], ["scroll", 0.5]
  ] as const)(
    "resumes after returning to bottom when growth precedes the %s callback (%s px movement)",
    (firstCallback, movement) => {
      const props: HarnessProps = { items: ["one"] };
      const view = render(<Harness {...props} />);
      const geometry: Geometry = {
        viewportHeight: 500,
        naturalHeight: 1300,
        top: 0,
        promptTop: 600,
        blockTop: 650,
        turnTop: 0
      };
      const { scroll } = installGeometry(geometry);
      act(() => view.rerender(<Harness {...props} />));
      act(() => wheel(scroll, -12));
      geometry.top = 800 - movement;
      act(() => { scroll.dispatchEvent(new Event("scroll")); });

      geometry.top = 800;
      geometry.naturalHeight = 1600;
      act(() => {
        if (firstCallback === "commit") view.rerender(<Harness {...props} />);
        else if (firstCallback === "observer") flushResize();
        else scroll.dispatchEvent(new Event("scroll"));
      });
      act(() => { scroll.dispatchEvent(new Event("scroll")); });
      geometry.naturalHeight = 1800;
      act(() => flushResize());

      expect(geometry.top).toBe(1300);
      expect(controller.showScrollToBottom).toBe(false);
    }
  );

  it.each(["commit", "observer", "scroll"])(
    "keeps following when content shrinks and regrows before the %s callback",
    (firstCallback) => {
      const props: HarnessProps = { items: ["one"] };
      const view = render(<Harness {...props} />);
      const geometry: Geometry = {
        viewportHeight: 500,
        naturalHeight: 1500,
        top: 0,
        promptTop: 600,
        blockTop: 650,
        turnTop: 0
      };
      const { scroll } = installGeometry(geometry);
      act(() => view.rerender(<Harness {...props} />));
      expect(geometry.top).toBe(1000);

      geometry.naturalHeight = 1100;
      // Model the browser clamping to the intermediate layout's scroll range.
      scroll.scrollTop = 1000;
      geometry.naturalHeight = 1700;
      act(() => {
        if (firstCallback === "commit") view.rerender(<Harness {...props} />);
        else if (firstCallback === "observer") flushResize();
        else scroll.dispatchEvent(new Event("scroll"));
      });
      geometry.naturalHeight = 1900;
      act(() => flushResize());

      expect(geometry.top).toBe(1400);
      expect(controller.showScrollToBottom).toBe(false);
    }
  );

  it("stays attached when a taller viewport clamps following to its new bottom", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 240,
      naturalHeight: 1191,
      top: 0,
      promptTop: 700,
      blockTop: 750,
      turnTop: 0
    };
    installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    expect(geometry.top).toBe(951);

    geometry.viewportHeight = 340;
    geometry.top = 851;
    act(() => flushResize());

    expect(geometry.top).toBe(851);
    expect(controller.showScrollToBottom).toBe(false);
  });

  it.each(["observer first", "scroll first"])(
    "restores a detached reader when viewport growth clamps before %s reconciliation",
    (order) => {
      const props: HarnessProps = { items: ["one"] };
      const view = render(<Harness {...props} />);
      const geometry: Geometry = {
        viewportHeight: 240,
        naturalHeight: 1191,
        top: 0,
        promptTop: 700,
        blockTop: 750,
        turnTop: 0
      };
      const { content, scroll } = installGeometry(geometry);
      act(() => view.rerender(<Harness {...props} />));
      act(() => wheel(scroll, -12));
      geometry.top = 939;
      scroll.dispatchEvent(new Event("scroll"));
      const blockViewportTop = geometry.blockTop - geometry.top;

      geometry.viewportHeight = 340;
      geometry.top = 851;
      if (order === "scroll first") scroll.dispatchEvent(new Event("scroll"));
      act(() => flushResize());

      expect(content.style.minHeight).toBe("1291px");
      expect(geometry.top).toBe(939);
      expect(geometry.blockTop - geometry.top).toBe(blockViewportTop);
      expect(controller.showScrollToBottom).toBe(true);
    }
  );

  it("freezes content height before an upward wheel scroll so a fold below cannot clamp the reader", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1300,
      top: 0,
      promptTop: 800,
      blockTop: 850,
      turnTop: 0
    };
    const { scroll, content } = installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    expect(geometry.top).toBe(800);

    act(() => wheel(scroll, -12));
    expect(content.style.minHeight).toBe("1300px");
    geometry.top = 788;
    scroll.dispatchEvent(new Event("scroll"));
    geometry.naturalHeight = 950;
    act(() => flushResize());

    expect(scroll.scrollHeight).toBe(1300);
    expect(geometry.top).toBe(788);
    expect(controller.showScrollToBottom).toBe(true);
  });

  it("preserves a fine-grained anchor when content changes above it inside one turn", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1300,
      top: 0,
      promptTop: 800,
      blockTop: 850,
      turnTop: 0
    };
    const { scroll } = installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    act(() => wheel(scroll, -12));
    geometry.top = 788;
    scroll.dispatchEvent(new Event("scroll"));
    const blockViewportTop = geometry.blockTop - geometry.top;

    geometry.blockTop += 240;
    geometry.naturalHeight += 240;
    act(() => flushResize());

    expect(geometry.blockTop - geometry.top).toBe(blockViewportTop);
    expect(geometry.top).toBe(1028);
  });

  it("leaves upward input inside a nested scroller or editor alone", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1000,
      top: 0,
      promptTop: 500,
      blockTop: 550,
      turnTop: 0
    };
    const { nested, scroll } = installGeometry(geometry);
    const input = document.createElement("textarea");
    nested.append(input);
    nested.scrollTop = 50;
    act(() => view.rerender(<Harness {...props} />));

    act(() => wheel(nested, -10));
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" }));
    });
    expect(controller.showScrollToBottom).toBe(false);

    nested.scrollTop = 0;
    act(() => wheel(nested, -10));
    expect(controller.showScrollToBottom).toBe(true);
    expect(scroll.scrollTop).toBe(500);
  });

  it("detaches on upward touch input and resets only for an explicit prompt or session change", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1200,
      top: 0,
      promptTop: 700,
      blockTop: 750,
      turnTop: 0
    };
    const { scroll } = installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    act(() => {
      touch(scroll, "touchstart", 100);
      touch(scroll, "touchmove", 120);
    });
    expect(controller.showScrollToBottom).toBe(true);

    geometry.naturalHeight = 1400;
    act(() => view.rerender(<Harness {...props} items={["one", "two"]} />));
    expect(controller.newBelowCount).toBe(1);

    act(() => view.rerender(<Harness {...props} resetKey="prompt-b" items={["one", "two"]} />));
    expect(controller.showScrollToBottom).toBe(false);
    expect(controller.newBelowCount).toBe(0);
    expect(geometry.top).toBe(scroll.scrollHeight - geometry.viewportHeight);

    act(() => wheel(scroll, -10));
    expect(controller.showScrollToBottom).toBe(true);
    act(() => view.rerender(
      <Harness sessionId="session-b" resetKey="prompt-b" items={["one", "two"]} />
    ));
    expect(controller.showScrollToBottom).toBe(false);
  });

  it("scrolls only its viewport to a requested element and stays detached", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 1300,
      top: 0,
      promptTop: 800,
      blockTop: 750,
      turnTop: 0
    };
    const { block, content } = installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));

    act(() => controller.scrollToElement(block));

    expect(geometry.top).toBe(750);
    expect(content.style.minHeight).toBe("1300px");
    expect(controller.showScrollToBottom).toBe(true);
  });

  it("removes layout ownership and native input handling while disabled", () => {
    const props: HarnessProps = { items: ["one"] };
    const view = render(<Harness {...props} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 900,
      top: 0,
      promptTop: 500,
      blockTop: 550,
      turnTop: 0
    };
    const { content, scroll } = installGeometry(geometry);
    act(() => view.rerender(<Harness {...props} />));
    expect(content.style.minHeight).toBe("980px");

    act(() => view.rerender(<Harness {...props} enabled={false} />));
    expect(content.style.minHeight).toBe("");
    act(() => wheel(scroll, -10));
    expect(controller.showScrollToBottom).toBe(false);
  });

  it("uses one observer for the viewport, wrapper, and rows, then cleans up native resources", () => {
    const view = render(<Harness items={["one"]} />);
    const geometry: Geometry = {
      viewportHeight: 500,
      naturalHeight: 900,
      top: 0,
      promptTop: 500,
      blockTop: 550,
      turnTop: 0
    };
    const { content, scroll, turn } = installGeometry(geometry);
    act(() => view.rerender(<Harness items={["one"]} />));

    expect(ResizeObserverMock.instances).toHaveLength(1);
    expect(ResizeObserverMock.instances[0]?.targets).toEqual(new Set([scroll, content, turn]));

    ResizeObserverMock.instances[0]?.fire();
    ResizeObserverMock.instances[0]?.fire();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    expect(ResizeObserverMock.instances[0]?.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
