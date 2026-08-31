// Netlify Function — proxy seguro para a API do Claude (Anthropic)
// Usada pelo "Assistente MTA" no site para responder com uma IA real.
//
// COMO CONFIGURAR:
// 1. Coloque este arquivo em: netlify/functions/claude-chat.js (mesma pasta do cf-proxy.js)
// 2. No painel do Netlify, va em Site settings > Environment variables
// 3. Crie uma variavel chamada ANTHROPIC_API_KEY com uma chave gerada em
//    https://console.anthropic.com/settings/keys
// 4. Faça o redeploy do site
//
// A chave NUNCA fica exposta no navegador — ela so existe aqui no servidor.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Metodo nao permitido' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'ANTHROPIC_API_KEY nao configurada. Adicione essa variavel de ambiente no painel do Netlify (Site settings > Environment variables) e faça o redeploy.'
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body invalido' }) };
  }

  const system = typeof payload.system === 'string' ? payload.system : '';
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];

  // Garante o formato esperado pela API (role: 'user' | 'assistant', content: string)
  const messages = rawMessages
    .filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim();
    })
    .map(function (m) {
      return { role: m.role, content: m.content };
    });

  if (!messages.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nenhuma mensagem enviada' }) };
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5', // troque aqui se quiser usar outro modelo da sua conta Anthropic
        max_tokens: 1024,
        system: system,
        messages: messages,
        tools: [
          { type: 'web_search_20250305', name: 'web_search' } // permite o assistente pesquisar na internet (clima, noticias, precos, etc)
        ]
      }),
      signal: AbortSignal.timeout(45000)
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers,
        body: JSON.stringify({ error: (data && data.error && data.error.message) || 'Erro na API do Claude' })
      };
    }

    // A resposta pode conter blocos de busca (server_tool_use / web_search_tool_result)
    // alem dos blocos de texto final. So o texto e enviado de volta ao chat.
    const reply = (data.content || [])
      .filter(function (c) { return c.type === 'text'; })
      .map(function (c) { return c.text; })
      .join('\n')
      .trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reply: reply || 'Desculpe, nao consegui gerar uma resposta agora.' })
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
