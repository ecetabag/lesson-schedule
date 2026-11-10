// Triggered by Vercel Cron. Auth is checked by the shared API handler.
import handler from './index.js';
export default async function cron(req,res){
 req.query = {...(req.query || {}), action:'automation'};
 return handler(req,res);
}
