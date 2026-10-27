"""A tiny stand-in for voluptuous: enough surface for the integration's
schemas to be BUILT and inspected. No validation semantics are claimed."""


class Invalid(Exception):
    pass


class Marker:
    def __init__(self, schema, default=None, description=None):
        self.schema = schema
        self.default = default
        self.description = description

    def __hash__(self):
        return hash(self.schema)

    def __eq__(self, other):
        return getattr(other, "schema", other) == self.schema

    def __str__(self):
        return str(self.schema)


class Required(Marker):
    pass


class Optional(Marker):
    pass


class Schema:
    def __init__(self, schema, extra=None):
        self.schema = schema

    def __call__(self, data):
        return data


def _passthrough(*args, **kwargs):
    return lambda value: value


All = Any = Range = Coerce = In = Length = Match = _passthrough
ALLOW_EXTRA = 1
