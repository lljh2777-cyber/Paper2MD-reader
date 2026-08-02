import { describe, expect, it } from "vitest";
import { FigureFollowState } from "../src/sync/figure-follow-state";

describe("FigureFollowState", () => {
  it("follows the reading target by default", () => {
    const state = new FigureFollowState();
    state.setFigures(["figure-1", "figure-2"]);
    state.trackReadingTarget("figure-2");
    expect(state.selected).toBe("figure-2");
    expect(state.readingTarget).toBe("figure-2");
  });

  it("keeps the displayed figure stable while follow mode is off", () => {
    const state = new FigureFollowState();
    state.setFigures(["figure-1", "figure-2"]);
    state.setFollowing(false);
    state.trackReadingTarget("figure-2");
    expect(state.selected).toBe("figure-1");
    expect(state.readingTarget).toBe("figure-2");
  });

  it("lets manual selection change the display without losing the reading target", () => {
    const state = new FigureFollowState();
    state.setFigures(["figure-1", "figure-2"]);
    state.setFollowing(false);
    state.trackReadingTarget("figure-2");
    state.select("figure-2");
    expect(state.selected).toBe("figure-2");
    expect(state.readingTarget).toBe("figure-2");
  });

  it("catches up to the current reading target when follow mode is re-enabled", () => {
    const state = new FigureFollowState();
    state.setFigures(["figure-1", "figure-2"]);
    state.setFollowing(false);
    state.trackReadingTarget("figure-2");
    state.setFollowing(true);
    expect(state.selected).toBe("figure-2");
    expect(state.isFollowing).toBe(true);
  });
});
