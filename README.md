# Nuvora API — Node.js na Vercel

API Node.js para os canais, mensagens, presença e sinalização das chamadas Nuvora. O endpoint Socket.IO fica em `/api/socket.io`; PostgreSQL guarda os dados e Redis compartilha presença e eventos entre instâncias.

## Publicar sem plano pago

1. Na Vercel, importe `hunterzyro-source/nuvoraapi` como um novo projeto. Use **Framework Preset: Other** e **Root Directory: `./`**. Não configure diretório de saída: este projeto publica apenas funções em `api/`, sem site estático. O `vercel.json` força a remoção de configurações de build e saída estática herdadas do painel.
2. Em **Storage**, conecte um banco Neon no plano gratuito. A integração da Vercel configura `DATABASE_URL`.
3. Crie um banco Redis gratuito no Upstash. Copie a URL de conexão TCP (`rediss://...`) e cadastre-a na Vercel como `REDIS_URL`.
4. Em **Environment Variables** do projeto da API, defina `COMMUNITY_PASSWORD` e `CORS_ORIGIN` com o domínio do site Nuvora na Vercel. Só compartilhe o código da comunidade com os participantes.
5. Publique o projeto da API e abra `https://<url-da-api>/api/health`. Confirme `"database":"postgres"` e `"sharedRealtime":true`.
6. No projeto Vercel do site Nuvora, defina `VITE_API_URL` como a URL HTTPS do projeto da API, sem barra final, e publique o site de novo.

As Functions da Vercel Hobby têm duração máxima de 300 segundos para a conexão WebSocket. O app reconecta e reentra nos canais e chamadas automaticamente; pode haver uma breve interrupção quando a conexão reinicia. O Redis precisa estar conectado para que participantes em instâncias diferentes recebam os mesmos eventos.

## Variáveis da API

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | URL PostgreSQL fornecida pelo Neon |
| `REDIS_URL` | URL Redis TCP/TLS do Upstash, no formato `rediss://...` |
| `COMMUNITY_PASSWORD` | Código compartilhado de acesso à comunidade |
| `CORS_ORIGIN` | Domínio exato do frontend Vercel |
| `PUBLIC_APP_URL` | URL pública do frontend (opcional) |

Não coloque credenciais de banco ou Redis em `VITE_*`, no código do frontend ou em commits.

## Execução local

Use Node.js 20 ou mais recente, configure as variáveis acima e execute `npm install` seguido de `npm start`. `npm run build` verifica a sintaxe das Functions. Em produção, mantenha somente uma publicação da API conectada ao mesmo Neon e Upstash.

## Voz, vídeo e tela

O backend troca eventos de sinalização; voz, câmera e tela seguem diretamente entre os navegadores via WebRTC. Chamadas mesh funcionam melhor em grupos pequenos. O navegador pode precisar reconectar a sinalização periodicamente por causa do limite de duração das Functions.
