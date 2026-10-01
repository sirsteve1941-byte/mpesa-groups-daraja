const express=require("express");
const fs=require("fs");
const path=require("path");
const axios=require("axios");
const crypto=require("crypto");
const app=express();
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname,"public")));
const DATA=path.join(__dirname,"data.json");
function load(){return JSON.parse(fs.readFileSync(DATA,"utf8"))}
function save(x){fs.writeFileSync(DATA,JSON.stringify(x,null,2))}
function normalizePhone(p){p=String(p||"").replace(/\s/g,""); if(/^0?7\d{8}$/.test(p)) return p.startsWith("0")?"254"+p.slice(1):"254"+p.slice(1); if(/^2547\d{8}$/.test(p)) return p; throw Error("Invalid M-Pesa number: "+p)}
async function token(){
 const base=process.env.MPESA_ENV==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke";
 const r=await axios.get(base+"/oauth/v1/generate?grant_type=client_credentials",{auth:{username:process.env.MPESA_CONSUMER_KEY,password:process.env.MPESA_CONSUMER_SECRET}});
 return r.data.access_token;
}
function stamp(){let d=new Date(Date.now()+3*60*60*1000);let s=d.toISOString().replace(/\D/g,"").slice(0,14);return s}
app.get("/api/health",(q,r)=>r.json({ok:true,configured:!!(process.env.MPESA_CONSUMER_KEY&&process.env.MPESA_CONSUMER_SECRET&&process.env.MPESA_PASSKEY&&process.env.MPESA_SHORTCODE&&process.env.MPESA_CALLBACK_URL)}));
app.get("/api/groups",(q,r)=>r.json(load()));
app.post("/api/import",(q,r)=>{try{let {rows}=q.body;if(!Array.isArray(rows))return r.status(400).json({message:"rows required"});let groups=Array.from({length:16},(_,i)=>({name:`Group ${i+1}`,customers:[]}));for(let j=0;j<rows.length;j++){let x=rows[j],m=/^Group\s+([1-9]|1[0-6])$/i.exec(String(x.group||""));if(!m)throw Error(`Invalid group on row ${j+1}`);let gi=+m[1]-1;if(groups[gi].customers.length>=6)throw Error(`${groups[gi].name} exceeds 6 customers`);let phone=normalizePhone(x.phone),auth=Number(x.auth),paid=Number(x.paid);if(!Number.isFinite(auth)||!Number.isFinite(paid)||auth<0||paid<0||paid>auth)throw Error(`Invalid amount on row ${j+1}`);groups[gi].customers.push({id:crypto.randomUUID(),name:x.name||"Customer",phone,auth,paid,step:0,status:paid>=auth?"completed":"pending",checkoutRequestId:null,lastReceipt:null})}save({groups});r.json({ok:true})}catch(e){r.status(400).json({message:e.message})}});
app.post("/api/customer",(q,r)=>{try{let {group,name,phone,auth}=q.body,d=load(),g=d.groups[group];if(!g)return r.status(400).json({message:"Invalid group"});if(g.customers.length>=6)return r.status(400).json({message:"Maximum 6 customers"});phone=normalizePhone(phone);auth=Number(auth);if(!Number.isFinite(auth)||auth<=0)throw Error("Invalid authorized total");g.customers.push({id:crypto.randomUUID(),name:name||"Customer",phone,auth,paid:0,step:0,status:"pending"});save(d);r.json({ok:true})}catch(e){r.status(400).json({message:e.message})}});
app.post("/api/stk-push",async(q,r)=>{try{
 let {customerId}=q.body,d=load(),found=null;for(const g of d.groups){found=g.customers.find(x=>x.id===customerId);if(found)break}
 if(!found)return r.status(404).json({message:"Customer not found"});let balance=found.auth-found.paid;if(balance<=0)return r.status(400).json({message:"Zero balance: STK is blocked"});
 if(!process.env.MPESA_CONSUMER_KEY||!process.env.MPESA_CONSUMER_SECRET||!process.env.MPESA_PASSKEY||!process.env.MPESA_SHORTCODE||!process.env.MPESA_CALLBACK_URL) return r.status(503).json({message:"Daraja server settings are incomplete"});
 let amounts=[500,490,480],amount=Math.min(amounts[Math.min(found.step||0,2)],balance),ts=stamp();
 let password=Buffer.from(String(process.env.MPESA_SHORTCODE)+String(process.env.MPESA_PASSKEY)+ts).toString("base64");
 let base=process.env.MPESA_ENV==="production"?"https://api.safaricom.co.ke":"https://sandbox.safaricom.co.ke",tok=await token();
 let body={BusinessShortCode:String(process.env.MPESA_SHORTCODE),Password:password,Timestamp:ts,TransactionType:process.env.MPESA_TRANSACTION_TYPE||"CustomerPayBillOnline",Amount:amount,PartyA:found.phone,PartyB:String(process.env.MPESA_SHORTCODE),PhoneNumber:found.phone,CallBackURL:process.env.MPESA_CALLBACK_URL,AccountReference:found.name||"MPESA GROUP",TransactionDesc:"M-Pesa Groups payment"};
 let rr=await axios.post(base+"/mpesa/stkpush/v1/processrequest",body,{headers:{Authorization:"Bearer "+tok}});
 found.checkoutRequestId=rr.data.CheckoutRequestID||null;found.status="stk_requested";found.lastStk=Date.now();save(d);r.json({ok:true,amount,...rr.data})}catch(e){r.status(e.response?.status||500).json({message:e.response?.data||e.message})}});
app.post("/api/mpesa/callback",(q,r)=>{try{let c=q.body?.Body?.stkCallback;if(!c)return r.json({ResultCode:0,ResultDesc:"Accepted"});let d=load(),x=null;for(const g of d.groups)for(const y of g.customers)if(y.checkoutRequestId===c.CheckoutRequestID)x=y;if(x&&Number(c.ResultCode)===0){let items=c.CallbackMetadata?.Item||[],receipt=items.find(i=>i.Name==="MpesaReceiptNumber")?.Value,amt=Number(items.find(i=>i.Name==="Amount")?.Value||0);x.paid=Math.min(x.auth,x.paid+amt);x.lastReceipt=receipt||null;x.status=x.paid>=x.auth?"completed":"pending";x.step=Math.min(2,(x.step||0)+1);x.checkoutRequestId=null;save(d)}else if(x){x.status="failed";x.checkoutRequestId=null;save(d)}r.json({ResultCode:0,ResultDesc:"Accepted"})}catch(e){r.json({ResultCode:0,ResultDesc:"Accepted"})}});
app.listen(process.env.PORT||3000,()=>console.log("M-Pesa Groups server running"));
