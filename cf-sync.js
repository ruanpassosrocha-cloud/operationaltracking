// Netlify Function — integração real com a API Analytics do Checklist Fácil
// Documentação confirmada pelo usuário em 04/07/2026:
//   Base:   https://api-analytics.checklistfacil.com.br
//   Auth:   Authorization: Bearer <CHAVE_DE_API>
//   Listar checklists aplicados: GET /v1/evaluations (filtros: checklistId, updatedAt[gte]/[lte], status, page, limit)
//   Respostas de 1 avaliação:    GET /v3/evaluations/{evaluationId}/results (itemId, text, evaluative, comment...)
//   Itens (perguntas) de um checklist: GET /v1/items?checklistId=X (itemId -> name)
//   Buscar checklists por nome: GET /v1/checklists?search=...
//
// Status do Checklist Aplicado (campo "status" em /v1/evaluations):
//   1 Não Iniciado | 2 Em Andamento | 3 Em Análise | 4 Reprovado | 5 Reaberto | 6 Concluído
// Escala avaliativa sim/não (campo "evaluative" em /v3/.../results):
//   7 = Não | 8 = Sim

const BASE = 'https://api-analytics.checklistfacil.com.br';
const STATUS_MAP = { 1: 'Não Iniciado', 2: 'Em Andamento', 3: 'Em Análise', 4: 'Reprovado', 5: 'Reaberto', 6: 'Concluído' };

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-cf-token',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.headers['x-cf-token'] || '';
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: 'Token não informado' }) };

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'pt-br'
  };

  // Guarda o snapshot mais recente da cota diária vista em qualquer chamada
  // desta execução, pra devolver junto de toda resposta (sucesso ou erro).
  let lastDailyInfo = null;

  async function cfFetch(path, retriesLeft) {
    if (retriesLeft === undefined) retriesLeft = 2;
    const resp = await fetch(BASE + path, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
    const dailyLimit = resp.headers.get('X-DailyLimit-Limit');
    const dailyRemaining = resp.headers.get('X-DailyLimit-Remaining');
    const dailyReset = resp.headers.get('X-DailyLimit-Reset');
    if (dailyLimit !== null) lastDailyInfo = { dailyLimit, dailyRemaining, dailyReset };

    if (resp.status === 429) {
      // Limite DIÁRIO esgotado — não adianta tentar de novo agora, só depois do reset.
      if (dailyRemaining === '0') {
        const err = new Error('Limite diário de requisições da API do Checklist Fácil foi atingido.');
        err.status = 429;
        err.dailyLimit = dailyLimit;
        err.dailyRemaining = dailyRemaining;
        err.dailyReset = dailyReset;
        throw err;
      }
      // Limite de 1x/minuto na mesma consulta — vale tentar de novo em instantes.
      if (retriesLeft > 0) {
        const retryAfterHeader = parseFloat(resp.headers.get('Retry-After'));
        const waitSeconds = Math.min(isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 0.8, 1.5);
        await new Promise(res => setTimeout(res, waitSeconds * 1000));
        return cfFetch(path, retriesLeft - 1);
      }
    }

    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* corpo não-JSON */ }
    if (!resp.ok) {
      const msg = (json && json.message) ? json.message : text.slice(0, 200);
      const err = new Error(`HTTP ${resp.status} em ${path} — ${msg}`);
      err.status = resp.status;
      err.dailyLimit = dailyLimit;
      err.dailyRemaining = dailyRemaining;
      err.dailyReset = dailyReset;
      throw err;
    }
    return json;
  }
  // Pequena pausa entre chamadas sequenciais, pra não estourar o limite de requisições/segundo.
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // Monta a resposta final sempre incluindo o snapshot mais recente da cota diária.
  function mkResponse(statusCode, obj) {
    if (lastDailyInfo) {
      obj.dailyLimit = lastDailyInfo.dailyLimit;
      obj.dailyRemaining = lastDailyInfo.dailyRemaining;
      obj.dailyReset = lastDailyInfo.dailyReset;
    }
    return { statusCode, headers, body: JSON.stringify(obj) };
  }

  const qs = event.queryStringParameters || {};
  const mode = qs.mode || 'sync';

  try {
    // ── Buscar checklists por nome (pra descobrir o checklistId de "02.1" e "02.2") ──
    if (mode === 'checklists') {
      const search = qs.search || '';
      let all = [], page = 1;
      while (true) {
        const data = await cfFetch(`/v1/checklists?search=${encodeURIComponent(search)}&page=${page}&limit=100`);
        all = all.concat(data.data || []);
        if (!data.meta || !data.meta.hasMore) break;
        page++;
        if (page > 10) break; // segurança (até 1000 resultados)
      }
      return mkResponse(200, { success: true, data: all });
    }

    // ── Listar itens (perguntas) de um checklist ──
    if (mode === 'items') {
      const checklistId = qs.checklistId;
      if (!checklistId) throw new Error('checklistId é obrigatório');
      let all = [], page = 1;
      while (true) {
        const data = await cfFetch(`/v1/items?checklistId=${checklistId}&page=${page}&limit=1000`);
        all = all.concat(data.data || []);
        if (!data.meta || !data.meta.hasMore) break;
        page++;
        if (page > 20) break; // segurança
      }
      return mkResponse(200, { success: true, data: all });
    }

    // ── Sincronização: busca avaliações atualizadas + respostas + monta linhas prontas ──
    if (mode === 'sync') {
      const checklistId = qs.checklistId;
      const since = qs.since || '';
      const maxEvaluations = Math.min(parseInt(qs.max || '40', 10) || 40, 100); // limite por chamada, evita timeout e rate-limit
      const startPage = parseInt(qs.page || '1', 10);
      if (!checklistId) throw new Error('checklistId é obrigatório');

      // 1. Itens do checklist -> mapa itemId -> nome da pergunta.
      // Se o front-end já mandou os IDs em cache (itemSerieId/itemOKId), pula
      // essa chamada inteira — é a forma mais simples de reduzir chamadas por
      // sincronização e evitar o rate-limit (HTTP 429) da API.
      let itemSerie = null, itemOK = null;
      if (qs.itemSerieId) itemSerie = { itemId: parseInt(qs.itemSerieId, 10), name: qs.itemSerieName || '' };
      if (qs.itemOKId)    itemOK    = { itemId: parseInt(qs.itemOKId, 10),    name: qs.itemOKName || '' };

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
        if (!itemOK)    itemOK    = items.find(it => norm(it.name).indexOf('EQUIPAMENTO OK') >= 0) || null;
      }

      // 2. Avaliações atualizadas desde "since" (uma página por chamada, com cursor)
      let path = `/v1/evaluations?checklistId=${checklistId}&page=${startPage}&limit=${maxEvaluations}`;
      if (since) path += `&updatedAt[gte]=${encodeURIComponent(since)}`;
      const evalData = await cfFetch(path);
      const evaluations = evalData.data || [];
      const hasMore = !!(evalData.meta && evalData.meta.hasMore);

      // 3. Pra cada avaliação, busca as respostas e extrai código/status/descrição
      //    (com pequena pausa entre chamadas pra não estourar o rate-limit)
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
        const rOK    = itemOK ? results.find(r => r.itemId === itemOK.itemId) : null;
        const valor = rSerie ? String(rSerie.text || '').trim() : '';
        if (!valor) continue;
        const equipOK = rOK ? (rOK.evaluative === 8 ? 'Sim' : (rOK.evaluative === 7 ? 'Não' : '')) : '';
        rows.push({
          evaluationId: ev.evaluationId,
          valor: valor,
          statusRaw: STATUS_MAP[ev.status] || '',
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
};
