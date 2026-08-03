import { Paper2MDDesktopApi } from "../shared/desktop-api";

declare global {
  interface Window {
    paper2mdDesktop: Paper2MDDesktopApi;
  }
}

export {};
