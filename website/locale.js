// Website copy is separate from the application catalogs. Demo pages and files
// are sample content, so their names and contents keep the original language.
const chinese = {
  title: 'Browser Recall：给浏览器添一点记性',
  description:
    '找回读过的网页，把标注和笔记一起保存。Browser Recall 把资料存放在你选择的文件夹里。',
  socialDescription:
    'Browser Recall 把浏览记录、标注、笔记和网页快照保存在你选择的文件夹里。',
  skip: '跳到正文',
  navigation: '主导航',
  heroTitle: '给浏览器<br />添一点<em>记性</em>。',
  heroDescription:
    '找回那篇原本想再看一遍的网页。Browser Recall 会保留浏览记录，也会保存你标出的段落和写下的笔记。',
  getStarted: '下载 Browser Recall',
  desktopDemo: 'Browser Recall 桌面应用演示',
  desktopImage: 'Browser Recall 的琥珀与黑白风格界面，展示浏览记录和多级列表',
  desktopStyle: '桌面应用风格',
  amber: '琥珀',
  mono: '黑白',
  highlightTitle: '随手记下你的想法。',
  highlightDescription:
    '在网页上划出一段文字，再在旁边写下笔记。同一网页想放进多少个列表都可以。',
  browserDemo: 'Browser Recall 浏览器扩展演示',
  noteImage: 'Browser Recall 笔记编辑器，显示在标出的段落旁边',
  storageTitle: '把资料放在你选的文件夹里。',
  storageDescription:
    'Browser Recall 把浏览记录、笔记和网页快照保存为可读文件。你可以直接打开，备份整个文件夹，也可以用自己的工具处理这些资料。',
  installTitle: '安装 Browser Recall',
  installDescription:
    '在同一台电脑上安装桌面应用和浏览器扩展，再到桌面应用中批准浏览器的连接请求。',
  installDesktop: '1. 安装桌面应用',
  desktopPlatforms: '适用于 macOS 和 Windows。',
  comingSoon: '即将上架',
  windowsInstaller: 'Windows 安装程序',
  releases: '查看 GitHub 上的所有版本',
  installExtension: '2. 安装浏览器扩展',
  browserPlatforms: '支持 Firefox、Chrome、Edge 和 Orion。',
  chrome: 'Chrome 及其他浏览器',
  privacy: '隐私说明',
  switchLanguage: '切换为英文',
  finderDemo: '在 Finder 中浏览 Browser Recall 示例数据文件夹',
  back: '返回上一个文件夹',
  forward: '前往下一个文件夹',
  preview: '预览所选文件',
  folders: '示例资料文件夹',
  favorites: '个人收藏',
  notes: '笔记',
  snapshots: '网页快照',
  logs: '浏览日志',
  checkpoints: '检查点',
  name: '名称',
  modified: '修改日期',
  kind: '种类',
  files: 'Browser Recall 文件',
  currentPath: '当前文件路径',
  closePreview: '关闭文件预览',
  folder: '文件夹',
  document: '文稿',
  expand: '展开 {name}',
  collapse: '折叠 {name}',
  items: '{count} 项',
  selectedItems: '{count} 项，已选中 1 项',
  libraryError: '无法加载示例资料。',
};
const english = {
  switchLanguage: 'Switch to Chinese',
  folder: 'Folder',
  document: 'Document',
  expand: 'Expand {name}',
  collapse: 'Collapse {name}',
  items: '{count} items',
  selectedItems: '{count} items, 1 selected',
  libraryError: 'The sample library could not be loaded.',
};

// The HTML owns each translation key and supplies the English fallback.
const bindings = [];
for (const attribute of [
  null,
  'html',
  'title',
  'alt',
  'aria-label',
  'content',
]) {
  const marker = attribute ? `data-i18n-${attribute}` : 'data-i18n';
  for (const element of document.querySelectorAll(`[${marker}]`)) {
    const key = element.getAttribute(marker);
    const target = attribute
      ? element
      : [...element.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
        );
    if (!target) throw new Error(`Missing website text: ${key}`);
    let original;
    if (attribute === 'html') original = element.innerHTML;
    else if (attribute) original = element.getAttribute(attribute);
    else original = target.textContent;
    bindings.push({ target, key, attribute, original });
  }
}
const storageKey = 'browser-recall-website-language';
function supportedLocale(value) {
  const language = String(value || '')
    .toLowerCase()
    .split(/[-_]/)[0];
  if (language === 'zh') return 'zh-CN';
  if (language === 'en') return 'en';
  return null;
}
function detectLocale() {
  const explicit = supportedLocale(
    new URL(location.href).searchParams.get('lang'),
  );
  if (explicit) return explicit;
  try {
    const saved = supportedLocale(localStorage.getItem(storageKey));
    if (saved) return saved;
  } catch {
    // Browser preferences still work when local storage is unavailable.
  }
  for (const language of navigator.languages || [navigator.language]) {
    const supported = supportedLocale(language);
    if (supported) return supported;
  }
  return 'en';
}
let locale = detectLocale();
export function getLocale() {
  return locale;
}
export function t(key, values = {}) {
  const message = (locale === 'zh-CN' ? chinese : english)[key];
  if (!message) throw new Error(`Missing website translation: ${key}`);
  return message.replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in values))
      throw new Error(`Missing translation value: ${name}`);
    return String(values[name]);
  });
}
function applyLocale() {
  document.documentElement.lang = locale;
  for (const { target, key, attribute, original } of bindings) {
    const value = locale === 'en' ? original : t(key);
    if (attribute === 'html') target.innerHTML = value;
    else if (attribute) target.setAttribute(attribute, value);
    else target.textContent = value;
  }
  const button = document.querySelector('#language-toggle');
  button.textContent = locale === 'en' ? '中文' : 'English';
  button.lang = locale === 'en' ? 'zh-CN' : 'en';
  button.setAttribute('aria-label', t('switchLanguage'));
  button.hidden = false;
  window.dispatchEvent(new Event('website-locale-change'));
}
export function onLocaleChange(callback) {
  window.addEventListener('website-locale-change', callback);
}
document.querySelector('#language-toggle').addEventListener('click', () => {
  locale = locale === 'en' ? 'zh-CN' : 'en';
  try {
    localStorage.setItem(storageKey, locale);
  } catch {
    // Switching remains available for this visit without persistent storage.
  }
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', locale);
    history.replaceState(history.state, '', url);
  }
  applyLocale();
});
window.addEventListener('languagechange', () => {
  locale = detectLocale();
  applyLocale();
});
applyLocale();
