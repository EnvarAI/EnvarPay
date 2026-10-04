import test from 'node:test';
import assert from 'node:assert/strict';
import {stripeProvider} from '../dist/commerce/stripe-provider.js';

test('Stripe transport binds explicit mode/account and preserves SDK idempotency without leaking provider errors',async()=>{
 const calls=[];let state='ready';const p=stripeProvider({secretKey:'sk_live_fixture',accountId:'acct_owned',merchantProfile:'profile_owned',mode:'live'},async(url,init)=>{
  calls.push({url,init});if(url.endsWith('/account'))return Response.json({id:state==='other'?'acct_other':'acct_owned',charges_enabled:state!=='disabled'});
  if(state==='error')return Response.json({error:{message:'spt_secret MUST NOT LEAK'}},{status:402});
  return Response.json({id:'pi_original',status:'succeeded',amount:50,amount_received:50,currency:'usd',livemode:true,metadata:{envarpay_order:'original'}});
 });
 await p.assertReady();state='other';await assert.rejects(p.assertReady(),/another account/);state='disabled';await assert.rejects(p.assertReady(),/not enabled/);
 state='ready';await p.create({amount:50,currency:'usd',metadata:{envarpay_order:'original'},shared_payment_granted_token:'spt_fixture'},{idempotencyKey:'stable-original-key',apiVersion:'2026-07-29.preview'});
 const call=calls.at(-1);assert.equal(call.init.headers.get('Idempotency-Key'),'stable-original-key');assert.equal(call.init.redirect,'error');assert.equal(call.init.body.get('metadata[envarpay_order]'),'original');
 state='error';await assert.rejects(p.retrieve('pi_original'),e=>!e.message.includes('spt_secret')&&e.code==='stripe_request_failed');
 assert.throws(()=>stripeProvider({secretKey:'sk_test_fixture',accountId:'acct_owned',merchantProfile:'profile_owned',mode:'live'}));
});
