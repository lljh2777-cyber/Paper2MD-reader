import { mountWebReader } from "./main";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Paper2MD Reader root is missing");
mountWebReader(root);
