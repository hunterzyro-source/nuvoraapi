# Nuvora API

API Node.js independente para canais, mensagens, presença e sinalização de chamadas do Nuvora. Usa Socket.IO para atualizações em tempo real e PostgreSQL para compartilhar dados entre todos os participantes. A voz, o vídeo e a tela usam WebRTC diretamente entre os participantes.

## Publicação

1. No Render, use **New → Blueprint** e escolha `hunterzyro-source/nuvoraapi`. O `render.yaml` cria um servidor WebSocket sempre ativo e PostgreSQL persistente; revise os recursos e custos antes de confirmar.
2. Defina `COMMUNITY_PASSWORD` no Render com um código forte e compartilhe-o somente com seus participantes.
3. Quando o Render mostrar a URL HTTPS, confirme `https://<url-da-api>/health`. A resposta deve incluir `"storage":"postgres"`.
4. No projeto do site na Vercel, defina `VITE_API_URL` com essa URL pública HTTPS sem barra final e faça novo deploy do frontend.

O domínio Vercel conhecido já está configurado em `CORS_ORIGIN`. Se o site usar outro domínio, atualize essa variável no Render para o domínio exato antes de usar a API. Para mais de um domínio, separe-os com vírgulas. `COMMUNITY_PASSWORD` protege a API e as conexões Socket.IO; os participantes digitam o mesmo código na tela de entrada do site.

## Execução local

Use Node.js 20 ou mais recente, rode `npm install` e depois `npm start`. Sem `DATABASE_URL`, os dados são guardados em SQLite local. Com `DATABASE_URL`, o servidor inicializa e usa PostgreSQL. `/health` indica o armazenamento ativo.

## Limites das chamadas

O servidor encaminha a sinalização inicial; o áudio e o vídeo fluem diretamente entre os navegadores para reduzir atraso. Isso atende melhor chamadas pequenas. Para redes que bloqueiam conexões diretas, adicione TURN; para grupos maiores, é necessário um SFU.
