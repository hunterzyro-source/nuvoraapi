import { server } from './app.js';

const port = Number(process.env.PORT || 3001);
server.listen(port, '0.0.0.0', () => console.log(`Nuvora API local na porta ${port}`));
