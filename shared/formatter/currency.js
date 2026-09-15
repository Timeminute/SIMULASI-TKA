export function formatCurrency(value){return new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR'}).format(Number(value)||0);}
