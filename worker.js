/* ============================================================
   Cloudflare Worker — Grupo MTA
   Substitui as 3 Netlify Functions que o site usava:
     /.netlify/functions/claude-chat  -> Assistente MTA (IA)
     /.netlify/functions/cf-proxy     -> proxy Checklist Fácil (não usado hoje pelo front-end)
     /.netlify/functions/cf-sync      -> sincronização Checklist Fácil (não usado hoje pelo front-end)
   Mantive exatamente os mesmos caminhos ("/.netlify/functions/...")
   pra não precisar mexer em nada dentro do index.html.
   Tudo que não bater com essas 3 rotas é servido como arquivo
   estático (o index.html) através do binding ASSETS.
   ============================================================ */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/.netlify/functions/claude-chat') {
      return handleClaudeChat(request, env);
    }
    if (url.pathname === '/.netlify/functions/cf-proxy') {
      return handleCfProxy(request, env);
    }
    if (url.pathname === '/.netlify/functions/cf-sync') {
      return handleCfSync(request, env);
    }

    // qualquer outro caminho -> arquivo estático (index.html etc.)
    return env.ASSETS.fetch(request);
  }
};

/* ---------- util ---------- */
function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-cf-token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  }, extra || {});
}
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: cors(extraHeaders) });
}

/* ============================================================
   1) /.netlify/functions/claude-chat
   Proxy seguro para a API do Claude (Anthropic) — usado pelo
   "Assistente MTA" no site para responder com uma IA real.

   CONFIGURAÇÃO NO CLOUDFLARE:
   Painel do Worker > Settings > Variables and Secrets > adicionar
   uma Secret chamada ANTHROPIC_API_KEY, com uma chave gerada em
   https://console.anthropic.com/settings/keys — depois fazer o
   redeploy (ou "Deploy" de novo).
   ============================================================ */
async function handleClaudeChat(request, env) {
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: cors() });
  if (request.method !== 'POST') return json({ error: 'Método não permitido' }, 405);

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({
      error: 'ANTHROPIC_API_KEY não configurada. Adicione essa variável em Settings > Variables and Secrets no painel do Worker no Cloudflare e faça o redeploy.'
    }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: 'Body inválido' }, 400);
  }

  const system = typeof payload.system === 'string' ? payload.system : '';
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

  const messages = rawMessages
    .filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim();
    })
    .map(function (m) {
      return { role: m.role, content: m.content };
    });

  if (!messages.length) return json({ error: 'Nenhuma mensagem enviada' }, 400);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: system,
        messages: messages,
        tools: [
          { type: 'web_search_20250305', name: 'web_search' }
        ]
      }),
      signal: AbortSignal.timeout(45000)
    });

    const data = await resp.json();

    if (!resp.ok) {
      return json({ error: (data && data.error && data.error.message) || 'Erro na API do Claude' }, resp.status);
    }

    const reply = (data.content || [])
      .filter(function (c) { return c.type === 'text'; })
      .map(function (c) { return c.text; })
      .join('\n')
      .trim();

    return json({ reply: reply || 'Desculpe, não consegui gerar uma resposta agora.' }, 200);
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

/* ============================================================
   2) /.netlify/functions/cf-proxy
   Proxy para API do Checklist Fácil (tenta alguns formatos de URL).
   Obs.: não é chamado por nenhum botão do site hoje — o Checklist
   Fácil é usado hoje via importação manual dos relatórios exportados.
   Mantido caso vocês voltem a usar a integração direta por API.
   ============================================================ */
async function handleCfProxy(request, env) {
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: cors() });

  const token = request.headers.get('x-cf-token') || '';
  if (!token) return json({ error: 'Token não informado' }, 400);

  const qs = Object.fromEntries(new URL(request.url).searchParams);
  const endpoint = qs.endpoint || 'aplicacoes';
  const perPage = qs.per_page || '200';
  const nome = qs.nome || '';
  const dataIni = qs.data_inicio || '';

  let queryStr = `?per_page=${perPage}`;
  if (nome) queryStr += `&nome=${encodeURIComponent(nome)}`;
  if (dataIni) queryStr += `&data_inicio=${encodeURIComponent(dataIni)}`;

  const BASE = 'https://integration.checklistfacil.com.br';

  const attempts = [
    { url: `${BASE}/v2/${endpoint}${queryStr}`, auth: `Bearer ${token}` },
    { url: `${BASE}/v1/${endpoint}${queryStr}`, auth: `Bearer ${token}` },
    { url: `${BASE}/${endpoint}${queryStr}`, auth: `Bearer ${token}` },
    { url: `${BASE}/v2/${endpoint}${queryStr}`, auth: token },
    { url: `${BASE}/v1/${endpoint}${queryStr}`, auth: token }
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
      try { body = await resp.text(); } catch (e) { /* ignora */ }
      log.push({ url: a.url, status: resp.status, preview: body.slice(0, 120) });

      if (resp.ok) {
        const data = JSON.parse(body);
        return json({ success: true, source: a.url, data: data }, 200, { 'x-cf-source': a.url });
      }
    } catch (e) {
      log.push({ url: a.url, error: e.message });
    }
  }

  return json({ success: false, error: 'Todos os formatos falharam', log: log }, 502);
}

/* ============================================================
   3) /.netlify/functions/cf-sync
   Integração com a API Analytics do Checklist Fácil (evaluations/results).
   Mesma observação do cf-proxy: hoje não é chamada pelo front-end.
   ============================================================ */
const CF_ANALYTICS_BASE = 'https://api-analytics.checklistfacil.com.br';
const CF_STATUS_MAP = { 1: 'Não Iniciado', 2: 'Em Andamento', 3: 'Em Análise', 4: 'Reprovado', 5: 'Reaberto', 6: 'Concluído' };

async function handleCfSync(request, env) {
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers: cors() });

  const token = request.headers.get('x-cf-token') || '';
  if (!token) return json({ success: false, error: 'Token não informado' }, 400);

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'pt-br'
  };

  let lastDailyInfo = null;

  async function cfFetch(path, retriesLeft) {
    if (retriesLeft === undefined) retriesLeft = 2;
    const resp = await fetch(CF_ANALYTICS_BASE + path, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
    const dailyLimit = resp.headers.get('X-DailyLimit-Limit');
    const dailyRemaining = resp.headers.get('X-DailyLimit-Remaining');
    const dailyReset = resp.headers.get('X-DailyLimit-Reset');
    if (dailyLimit !== null) lastDailyInfo = { dailyLimit, dailyRemaining, dailyReset };

    if (resp.status === 429) {
      if (dailyRemaining === '0') {
        const err = new Error('Limite diário de requisições da API do Checklist Fácil foi atingido.');
        err.status = 429; err.dailyLimit = dailyLimit; err.dailyRemaining = dailyRemaining; err.dailyReset = dailyReset;
        throw err;
      }
      if (retriesLeft > 0) {
        const retryAfterHeader = parseFloat(resp.headers.get('Retry-After'));
        const waitSeconds = Math.min(isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 0.8, 1.5);
        await new Promise(res => setTimeout(res, waitSeconds * 1000));
        return cfFetch(path, retriesLeft - 1);
      }
    }

    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* corpo não-JSON */ }
    if (!resp.ok) {
      const msg = (data && data.message) ? data.message : text.slice(0, 200);
      const err = new Error(`HTTP ${resp.status} em ${path} — ${msg}`);
      err.status = resp.status; err.dailyLimit = dailyLimit; err.dailyRemaining = dailyRemaining; err.dailyReset = dailyReset;
      throw err;
    }
    return data;
  }
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  function mkResponse(statusCode, obj) {
    if (lastDailyInfo) {
      obj.dailyLimit = lastDailyInfo.dailyLimit;
      obj.dailyRemaining = lastDailyInfo.dailyRemaining;
      obj.dailyReset = lastDailyInfo.dailyReset;
    }
    return json(obj, statusCode);
  }

  const qs = Object.fromEntries(new URL(request.url).searchParams);
  const mode = qs.mode || 'sync';

  try {
    if (mode === 'checklists') {
      const search = qs.search || '';
      let all = [], page = 1;
      while (true) {
        const data = await cfFetch(`/v1/checklists?search=${encodeURIComponent(search)}&page=${page}&limit=100`);
        all = all.concat(data.data || []);
        if (!data.meta || !data.meta.hasMore) break;
        page++;
        if (page > 10) break;
      }
      return mkResponse(200, { success: true, data: all });
    }

    if (mode === 'items') {
      const checklistId = qs.checklistId;
      if (!checklistId) throw new Error('checklistId é obrigatório');
      let all = [], page = 1;
      while (true) {
        const data = await cfFetch(`/v1/items?checklistId=${checklistId}&page=${page}&limit=1000`);
        all = all.concat(data.data || []);
        if (!data.meta || !data.meta.hasMore) break;
        page++;
        if (page > 20) break;
      }
      return mkResponse(200, { success: true, data: all });
    }

    if (mode === 'sync') {
      const checklistId = qs.checklistId;
      const since = qs.since || '';
      const maxEvaluations = Math.min(parseInt(qs.max || '40', 10) || 40, 100);
      const startPage = parseInt(qs.page || '1', 10);
      if (!checklistId) throw new Error('checklistId é obrigatório');

      let itemSerie = null, itemOK = null;
      if (qs.itemSerieId) itemSerie = { itemId: parseInt(qs.itemSerieId, 10), name: qs.itemSerieName || '' };
      if (qs.itemOKId) itemOK = { itemId: parseInt(qs.itemOKId, 10), name: qs.itemOKName || '' };

      if (!itemSerie || !itemOK) {
        let items = [], ipage = 1;
        while (true) {
          const data = await cfFetch(`/v1/items?checklistId=${checklistId}&page=${ipage}&limit=1000`);
          items = items.concat(data.data || []);
          if (!data.meta || !data.meta.hasMore) break;
          ipage++;
          if (ipage > 20) break;
        }
        const norm = (s) => (s || '').toUpperCase()
          .replace(/É/g, 'E').replace(/Ê/g, 'E').replace(/Ã/g, 'A').replace(/Ç/g, 'C').replace(/Ú/g, 'U').replace(/Í/g, 'I');
        if (!itemSerie) itemSerie = items.find(it => norm(it.name).indexOf('INFORME') >= 0) || null;
        if (!itemOK) itemOK = items.find(it => norm(it.name).indexOf('EQUIPAMENTO OK') >= 0) || null;
      }

      let path = `/v1/evaluations?checklistId=${checklistId}&page=${startPage}&limit=${maxEvaluations}`;
      if (since) path += `&updatedAt[gte]=${encodeURIComponent(since)}`;
      const evalData = await cfFetch(path);
      const evaluations = evalData.data || [];
      const hasMore = !!(evalData.meta && evalData.meta.hasMore);

      const rows = [];
      const errors = [];
      for (const ev of evaluations) {
        if (ev.deletedAt) continue;
        let results;
        try {
          const rdata = await cfFetch(`/v3/evaluations/${ev.evaluationId}/results`);
          results = rdata.data || [];
        } catch (e) {
          errors.push({ evaluationId: ev.evaluationId, error: e.message });
          continue;
        } finally {
          await sleep(120);
        }
        const rSerie = itemSerie ? results.find(r => r.itemId === itemSerie.itemId) : null;
        const rOK = itemOK ? results.find(r => r.itemId === itemOK.itemId) : null;
        const valor = rSerie ? String(rSerie.text || '').trim() : '';
        if (!valor) continue;
        const equipOK = rOK ? (rOK.evaluative === 8 ? 'Sim' : (rOK.evaluative === 7 ? 'Não' : '')) : '';
        rows.push({
          evaluationId: ev.evaluationId,
          valor: valor,
          statusRaw: CF_STATUS_MAP[ev.status] || '',
          equipOK: equipOK,
          data: (ev.concludedAt || ev.approvedAt || ev.startedAt || '').slice(0, 10),
          updatedAt: ev.updatedAt
        });
      }

      return mkResponse(200, {
        success: true,
        checklistId: checklistId,
        itemSerieId: itemSerie ? itemSerie.itemId : null,
        itemSerieName: itemSerie ? itemSerie.name : null,
        itemOKId: itemOK ? itemOK.itemId : null,
        itemOKName: itemOK ? itemOK.name : null,
        totalEvaluationsNaPagina: evaluations.length,
        rows: rows,
        errors: errors,
        hasMore: hasMore,
        nextPage: hasMore ? (startPage + 1) : null,
        lastUpdatedAtNaPagina: evaluations.length ? evaluations[evaluations.length - 1].updatedAt : null
      });
    }

    throw new Error('Parâmetro "mode" inválido: ' + mode);
  } catch (e) {
    const body = { success: false, error: e.message };
    if (e.dailyRemaining !== undefined) {
      body.dailyLimit = e.dailyLimit;
      body.dailyRemaining = e.dailyRemaining;
      body.dailyReset = e.dailyReset;
    }
    return mkResponse(e.status || 500, body);
  }
}
