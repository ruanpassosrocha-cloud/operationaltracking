// Netlify Function — proxy para API do Checklist Fácil
// URL Base CORRETA: https://integration.checklistfacil.com.br/
// Header: Authorization: Bearer <CHAVE_DE_API>
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-cf-token',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.headers['x-cf-token'] || '';
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token não informado' }) };

  const qs       = event.queryStringParameters || {};
  const endpoint = qs.endpoint || 'aplicacoes';
  const perPage  = qs.per_page || '200';
  const nome     = qs.nome || '';
  const dataIni  = qs.data_inicio || '';

  // Build query string
  let queryStr = `?per_page=${perPage}`;
  if (nome)    queryStr += `&nome=${encodeURIComponent(nome)}`;
  if (dataIni) queryStr += `&data_inicio=${encodeURIComponent(dataIni)}`;

  // CORRECT base URL from documentation
  const BASE = 'https://integration.checklistfacil.com.br';

  // Try the correct URL with Bearer token (as documented)
  const attempts = [
    { url: `${BASE}/v2/${endpoint}${queryStr}`,  auth: `Bearer ${token}` },
    { url: `${BASE}/v1/${endpoint}${queryStr}`,  auth: `Bearer ${token}` },
    { url: `${BASE}/${endpoint}${queryStr}`,      auth: `Bearer ${token}` },
    { url: `${BASE}/v2/${endpoint}${queryStr}`,  auth: token },
    { url: `${BASE}/v1/${endpoint}${queryStr}`,  auth: token },
  ];

  const log = [];

  for (const a of attempts) {
    try {
      const resp = await fetch(a.url, {
        headers: {
          'Authorization': a.auth,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Accept-Language': 'pt-br'
        },
        signal: AbortSignal.timeout(8000)
      });

      let body = '';
      try { body = await resp.text(); } catch(e) {}
      log.push({ url: a.url, status: resp.status, preview: body.slice(0, 120) });

      if (resp.ok) {
        const data = JSON.parse(body);
        return {
          statusCode: 200,
          headers: { ...headers, 'x-cf-source': a.url },
          body: JSON.stringify({ success: true, source: a.url, data })
        };
      }
    } catch(e) {
      log.push({ url: a.url, error: e.message });
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ success: false, error: 'Todos os formatos falharam', log })
  };
};
