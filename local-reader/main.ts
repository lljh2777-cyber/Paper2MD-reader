// Compatibility entry for existing Local Reader and Sites deployments.
export {
  mountWebReader as mountLocalReader,
  mountWebReaderWithReady as mountLocalReaderWithReady,
  type WebReaderMountHandle as LocalReaderMountHandle,
  type WebReaderMountOptions as LocalReaderMountOptions
} from "../apps/web/src/main";
