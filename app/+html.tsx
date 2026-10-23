import { ScrollViewStyleReset } from 'expo-router/html';
import type { ReactNode } from 'react';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="nl">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        {/*
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native.
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {/* Using raw CSS styles as an escape-hatch to ensure the background color never flickers in dark-mode. */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body>{children}</body>
    </html>
  );
}

// One focus style for keyboard users (D-07/D-08): accent, rounded, only for keyboard focus. Text
// inputs show focus on their rounded container instead (QuickAddBar), so they get no own outline.
const responsiveBackground = `
body {
  background-color: #fff;
}
:focus { outline: none; }
:focus-visible { outline: 2px solid #1E7A4C; outline-offset: 2px; }
input:focus-visible, textarea:focus-visible { outline: none; }
@media (prefers-color-scheme: dark) {
  body {
    background-color: #0F1110;
  }
  :focus-visible { outline-color: #4CC38A; }
}`;
