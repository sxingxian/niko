// The browser build of kokoro-js has the same API as its typed Node entry.
declare module 'kokoro-web' {
  export * from 'kokoro-js';
}
