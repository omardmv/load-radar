import json, time
from gliner2 import GLiNER2
model = GLiNER2.from_pretrained("fastino/gliner2-base-v1")
schema = (model.create_schema()
  .entities({"origin_city": "city or town where the empty truck is", "destination": "destination city, state or 'anywhere'",
             "rate_per_mile": "minimum pay in dollars per mile", "deadhead_miles": "radius or deadhead distance in miles"})
  .classification("equipment", ["van", "reefer", "flatbed"]))
for text in [
  "FLATBED CHICAGO IL -> TX/OK DH 150 RPM 3.1",
  "reefer outta fresno 3.40+ no more than 100 deadhead",
  "got a dry van empty in joliet tmrw, anything to the southeast over $2.80",
  "stepdeck near savanah ga, want 4/mi or better",
  "53 ft reefer, Laredo, going north, 75mi DH",
  "need loads out of dallas",
]:
    t = time.perf_counter(); out = model.extract(text, schema); ms = (time.perf_counter() - t) * 1000
    print(f"{ms:5.0f} ms | {text}\n         {json.dumps(out)}")
