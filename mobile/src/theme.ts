// The "visual calm" rules: cream background, calm green accent, received bubbles ALWAYS white, my bubbles soft green, colour only on names.
export const theme = {
  bg: '#F4F1E8', card: '#FFFEFA', ink: '#2B2F2C', muted: '#6C736E', line: '#E3DFD2',
  green: '#1F4D3F', greenSoft: '#E1ECE4', mine: '#DCEBDD', white: '#FFFFFF', danger: '#B3261E',
};
export const nameColors = ['#8A3B2E', '#1F5A8C', '#6B4A8E', '#2E6B4F', '#9A5B13', '#2F6B7A', '#8E3A5E', '#4D5A1F', '#5A3E8C', '#7A4A2A'];
export const colorOf = (id: number | null) => nameColors[Math.abs(id ?? 0) % nameColors.length];
