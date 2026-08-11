process.env.BROWSER_RECALL_PLAYWRIGHT_ENGINE = 'webkit';

const { default: config } = await import('./playwright.config.js');

export default config;
