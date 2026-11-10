import assert from 'node:assert/strict';
import {test} from 'node:test';
import {matchingNgrokTunnel,findReusableNgrokTunnel,describeNgrokExit} from '../desktop/ngrok-reuse.mjs';

const matching = {tunnels:[{
  public_url:'https://reserved-example.ngrok-free.dev',
  config:{addr:'http://localhost:8787'},
}]};

test('only a matching HTTPS origin and loopback proxy port may be reused',()=>{
  assert.equal(matchingNgrokTunnel(matching,'https://reserved-example.ngrok-free.dev',8787),true);
  assert.equal(matchingNgrokTunnel(matching,'https://other.ngrok-free.dev',8787),false);
  assert.equal(matchingNgrokTunnel(matching,'https://reserved-example.ngrok-free.dev',8899),false);
  assert.equal(matchingNgrokTunnel({tunnels:[{...matching.tunnels[0],
    config:{addr:'http://remote.example.com:8787'}}]},
  'https://reserved-example.ngrok-free.dev',8787),false);
  assert.equal(matchingNgrokTunnel({tunnels:[{...matching.tunnels[0],
    config:{addr:'http://localhost:8787/another-route'}}]},
  'https://reserved-example.ngrok-free.dev',8787),false);
});

test('local discovery ignores unrelated ngrok endpoints and never performs mutating calls',async()=>{
  const urls=[];
  const result=await findReusableNgrokTunnel('https://reserved-example.ngrok-free.dev',8787,{
    ports:[4040,4041],
    fetchImpl:async(url)=>{
      urls.push(url);
      return {ok:true,json:async()=> url.includes('4040') ?
        {tunnels:[{public_url:'https://another.ngrok-free.dev',
          config:{addr:'http://localhost:1475'}}]} : matching};
    },
  });
  assert.deepEqual(result,{apiPort:4041});
  assert.deepEqual(urls.sort(),[
    'http://127.0.0.1:4040/api/tunnels','http://127.0.0.1:4041/api/tunnels',
  ]);
});

test('discovery fails closed on API failures and ambiguous multiple matches',async()=>{
  assert.equal(await findReusableNgrokTunnel('https://reserved-example.ngrok-free.dev',8787,{
    ports:[4040,4041],fetchImpl:async()=>{throw Error('agent missing');},
  }),null);
  assert.equal(await findReusableNgrokTunnel('https://reserved-example.ngrok-free.dev',8787,{
    ports:[4040,4041],fetchImpl:async()=>({ok:true,json:async()=>matching}),
  }),null);
});

test('endpoint already online gets a specific actionable error instead of token advice',()=>{
  assert.match(describeNgrokExit('ERR_NGROK_334'),/already online/i);
  assert.match(describeNgrokExit('ERR_NGROK_334'),/another tunnel/i);
  assert.match(describeNgrokExit('ERR_NGROK_320'),/another account/i);
  assert.match(describeNgrokExit('ERR_NGROK_999'),/ERR_NGROK_999/);
});
