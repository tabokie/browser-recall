// Share the blog's GoatCounter dashboard. Local previews and embedded demos
// never load the external script; only the HTTPS product page is counted.
if (
  location.protocol === 'https:' &&
  !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) &&
  window.top === window.self
) {
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://gc.zgo.at/count.js';
  script.dataset.goatcounter = 'https://tabokie.goatcounter.com/count';
  script.dataset.goatcounterSettings = JSON.stringify({
    path: '/browser-recall/',
    no_events: true,
  });
  document.head.appendChild(script);
}
