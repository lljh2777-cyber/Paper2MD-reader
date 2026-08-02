import { mountLocalReader } from "./main";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Local Reader root is missing");
mountLocalReader(root);
