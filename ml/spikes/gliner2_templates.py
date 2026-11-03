import json, sys, time
from gliner2 import GLiNER2
data = sys.argv[1]
phrases = []
for line in open(f"{data}/searches.ndjson"):
    u = json.loads(line)
    for s in u["searches"]:
        phrases.append((s["text"], s))
    if len(phrases) >= 10: break
phrases = phrases[:10]
t = time.time(); model = GLiNER2.from_pretrained("fastino/gliner2-base-v1"); print(f"load {time.time()-t:.1f}s", flush=True)
schema = (model.create_schema()
  .entities({"origin_city": "city or town where the empty truck is", "destination": "destination city, state or 'anywhere'",
             "rate_per_mile": "minimum pay in dollars per mile", "deadhead_miles": "radius or deadhead distance in miles"})
  .classification("equipment", ["van", "reefer", "flatbed"]))
for text, truth in phrases:
    t = time.perf_counter(); out = model.extract(text, schema); ms = (time.perf_counter() - t) * 1000
    want = {"equipment": truth["equipment"], "origin": truth["origin"]["city"], "dh": truth["deadhead_mi"], "rpm": truth["min_rpm"], "dest": truth["dest"].get("kind")}
    print(f"\n{ms:6.0f} ms | {text}\n  got:  {json.dumps(out)}\n  want: {want}")
