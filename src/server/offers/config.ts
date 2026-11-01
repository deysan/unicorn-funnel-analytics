// Початкові значення — docs/requirements.md. Партнер синтетичний;
// секрети й реальні інтеграції не є частиною каталогу.
export const offerConfig = {
  partners: ['demo-partner'],
  offers: [
    { id: '001', name: 'Asia Women', ethnicity: 'asia', genders: ['women'], epu_usd: 0.80, active: true, partner_id: 'demo-partner', url: 'https://asia-women.example' },
    { id: '002', name: 'Asia Men', ethnicity: 'asia', genders: ['men'], epu_usd: 0.65, active: true, partner_id: 'demo-partner', url: 'https://asia-men.example' },
    { id: '003', name: 'Asia Connect', ethnicity: 'asia', genders: ['women', 'men'], epu_usd: 0.95, active: true, partner_id: 'demo-partner', url: 'https://asia-connect.example' },
    { id: '004', name: 'Europe Women', ethnicity: 'europe', genders: ['women'], epu_usd: 1.10, active: true, partner_id: 'demo-partner', url: 'https://europe-women.example' },
    { id: '005', name: 'Europe Connect', ethnicity: 'europe', genders: ['women', 'men'], epu_usd: 0.70, active: true, partner_id: 'demo-partner', url: 'https://europe-connect.example' },
    { id: '006', name: 'Latin Men', ethnicity: 'latam', genders: ['men'], epu_usd: 0.60, active: true, partner_id: 'demo-partner', url: 'https://latin-men.example' },
    { id: '007', name: 'Global Connect', ethnicity: 'any', genders: ['women', 'men'], epu_usd: 0.50, active: true, partner_id: 'demo-partner', url: 'https://global-connect.example' },
  ],
};
