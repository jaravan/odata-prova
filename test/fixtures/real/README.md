# Real-world metadata

Unmodified `$metadata` documents of public sample services, used to check that the server
loads services it was not written for (see `test/real-metadata.test.js`).

| Folder        | Source                                                             |
| ------------- | ------------------------------------------------------------------ |
| `NorthwindV2` | https://services.odata.org/V2/Northwind/Northwind.svc/$metadata    |
| `NorthwindV4` | https://services.odata.org/V4/Northwind/Northwind.svc/$metadata    |
| `TripPin`     | https://services.odata.org/V4/TripPinServiceRW/$metadata           |

The services are OData.org's reference services (Northwind is Microsoft's sample
database). `TripPin/data/People.json` is a one-row excerpt of TripPin's sample data.
