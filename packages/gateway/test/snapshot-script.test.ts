import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSnapshot } from "../src/browser.js";
import { SNAPSHOT_SCRIPT } from "../src/snapshot-script.js";

class FakeElement {
  readonly ownerDocument = { defaultView: { getComputedStyle: styleOf } };
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  innerText = "";
  type = "";
  value = "";

  constructor(
    readonly tagName: string,
    private readonly interesting = true,
  ) {}

  append(...children: FakeElement[]): this {
    this.children.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  matches(): boolean {
    return this.interesting;
  }
}

function styleOf(element: FakeElement): { display: string; visibility: string } {
  return {
    display: element.getAttribute("data-display") ?? "block",
    visibility: element.getAttribute("data-visibility") ?? "visible",
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("SNAPSHOT_SCRIPT", () => {
  it("clears old stamps, skips hidden subtrees, and never reports password values", () => {
    const body = new FakeElement("BODY", false);
    const password = new FakeElement("INPUT");
    password.type = "password";
    password.value = "secret";
    password.setAttribute("aria-label", "Password");
    password.setAttribute("data-tg-ref", "r1-e9");

    const hidden = new FakeElement("DIV", false);
    hidden.setAttribute("data-display", "none");
    const hiddenButton = new FakeElement("BUTTON");
    hiddenButton.innerText = "Invisible";
    hidden.append(hiddenButton);

    const button = new FakeElement("BUTTON");
    button.innerText = "Continue";
    body.append(password, hidden, button);

    vi.stubGlobal("document", {
      body,
      title: "Fixture",
      querySelectorAll: () => [password],
    });
    vi.stubGlobal("location", { href: "https://example.test/login?token=secret" });

    const run = new Function(`return (${SNAPSHOT_SCRIPT})(4)`) as () => {
      nodes: Array<Record<string, unknown>>;
    };
    const raw = run();

    expect(raw.nodes).toEqual([
      { index: 0, role: "textbox", name: "Password", depth: 1 },
      { index: 1, role: "button", name: "Continue", depth: 1 },
    ]);
    expect(password.getAttribute("data-tg-ref")).toBe("r4-e0");
    expect(hiddenButton.getAttribute("data-tg-ref")).toBeNull();
  });
});

describe("buildSnapshot", () => {
  it("assigns revision-scoped refs in document order and bounds metadata", () => {
    const snapshot = buildSnapshot(
      {
        revision: 3,
        url: "https://user:pw@example.com/x?token=1#f",
        title: "T".repeat(400),
        nodes: [
          { index: 0, role: "heading", name: "Hello", depth: 0 },
          { index: 1, role: "textbox", name: "Username", value: "ada", depth: 1 },
        ],
      },
      "tab-1",
    );

    expect(snapshot.nodes.map((node) => node.ref)).toEqual(["r3-e0", "r3-e1"]);
    expect(snapshot.url).toBe("https://example.com/x");
    expect(snapshot.title).toHaveLength(200);
  });

  it("bounds node names and values", () => {
    const snapshot = buildSnapshot(
      {
        revision: 1,
        url: "https://x/",
        title: "t",
        nodes: [
          {
            index: 0,
            role: "textbox",
            name: "n".repeat(500),
            value: "v".repeat(500),
            depth: 0,
          },
        ],
      },
      "tab-1",
    );
    expect(snapshot.nodes[0].name.length).toBeLessThanOrEqual(200);
    expect(snapshot.nodes[0].value!.length).toBeLessThanOrEqual(200);
  });

  it("rejects a snapshot whose node count exceeds the cap before mapping it", () => {
    const nodes = Array.from({ length: 2001 }, (_, index) => ({
      index,
      role: "button",
      name: "x",
      depth: 0,
    }));
    expect(() =>
      buildSnapshot({ revision: 1, url: "https://x/", title: "t", nodes }, "t1"),
    ).toThrow();
  });
});
