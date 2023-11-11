create unique index idx_userid_starttime on "Booking" ("userId", "startTime") where "userId" is not null and status = 'accepted';
