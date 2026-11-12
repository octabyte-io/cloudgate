/**
 * A cloud Delete or removal that failed before anything in the cloud was
 * touched: the run that catches it puts its row back as it was, rather than
 * marking it `delete-incomplete`, since there is nothing left behind to list.
 *
 * One class for every such run (an Application's, a database's, a bucket's,
 * a Stack VM's Delete and an Environment network's removal), after each had
 * declared its own copy (#1357 review, §1.4). Each run catches only what it
 * threw itself: none of them calls another.
 */
export class NothingRemoved extends Error {}
