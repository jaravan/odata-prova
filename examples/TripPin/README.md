# TripPin (OData V4)

An example of a V4 service with actions and functions: bound to an entity
(`GetFavoriteAirline`, `ShareTrip`), and imported into the container (`GetNearestAirport`,
`ResetDataSource`). The server routes the calls, logs them with their parameters and answers
with what the return type allows, see the [odata-server README](../../odata-server/README.md#actions-and-functions).

```sh
make odata-up MODEL=TripPin
curl 'http://localhost:3000/odata/v4/TripPin/People?$select=UserName,FirstName,Gender'
curl 'http://localhost:3000/odata/v4/TripPin/GetNearestAirport(lat=33.9,lon=-118.4)'
```

On V2, the bound operations are function imports that take the person's key (`UserName`)
as a parameter, as SAP Gateway writes them: `ShareTrip?UserName='1'&userName='bob'&tripId=1`.
`GetInvolvedPeople` is left out of V2, since trips have no entity set of their own, and so are
the collection-valued properties.

`metadata.xml` is OData.org's TripPin service, unmodified
(https://services.odata.org/V4/TripPinServiceRW/$metadata). It has no data files: the server
generates mock data for every entity set. Some navigations are switched off at startup (logged),
because the metadata gives no join condition for them or their target has no entity set.
