const PALETTES = {
  amber: {
    accent: '#D07030',
    bgBase: '#FFF8F0',
    borderSubtle: 'rgba(180, 160, 140, 0.15)',
    borderSection: 'rgba(180, 160, 140, 0.1)',
    shadowColor: '53, 40, 32',
    textPrimary: '#352820',
    textSecondary: '#5E4D3E',
    textMuted: '#8E7D6D',
    excerptBg: '#fff8dc',
    excerptBorder: '#f0c040',
  },
  mono: {
    accent: '#1A1A1A',
    bgBase: '#FFFFFF',
    borderSubtle: 'rgba(0, 0, 0, 0.08)',
    borderSection: 'rgba(0, 0, 0, 0.06)',
    shadowColor: '0, 0, 0',
    textPrimary: '#1A1A1A',
    textSecondary: '#555555',
    textMuted: '#999999',
    excerptBg: '#F8F8F8',
    excerptBorder: '#1A1A1A',
  },
  rose: {
    accent: '#D84070',
    bgBase: '#FFECE8',
    borderSubtle: 'rgba(180, 138, 140, 0.18)',
    borderSection: 'rgba(180, 138, 140, 0.12)',
    shadowColor: '58, 30, 34',
    textPrimary: '#3C1C20',
    textSecondary: '#64303A',
    textMuted: '#905862',
    excerptBg: '#FAE0DC',
    excerptBorder: '#E86898',
  },
};

export const SCHEME_HEX = Object.fromEntries(
  Object.entries(PALETTES).map(([k, v]) => [k, v.accent])
);

export function getSchemePalette(scheme) {
  return PALETTES[scheme] || PALETTES.amber;
}
