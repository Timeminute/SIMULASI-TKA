export default {
 async fetch(request, env) {
   return new Response(JSON.stringify({
     status:"ok",
     message:"Simulasi TKA API aktif"
   }),{
     headers:{'content-type':'application/json'}
   });
 }
}
